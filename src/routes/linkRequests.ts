import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireManager, requireRole } from "../middleware/roles";
import { findCamperById } from "../models/campers";
import { actingToken, coordinationToken } from "../services/acting";
import { isFamilyOfEdition, registerProposedResponsible } from "../services/coreRegistration";
import { markJoinWelcome, takeJoinWelcome } from "../models/userCampState";
import { welcomeLateFamilies } from "../services/notify";
import { coreClient } from "../services/ipalpha";
import { IpalphaRejected, PERSONS_RESOURCE, type LinkRequest } from "../services/ipalpha/coreClient";
import { normalizeBrazilPhone, titleCaseName } from "../utils";

/**
 * /api/link-requests — another responsável for a kid (decision 80, CONTRACTS §25).
 * A camp role never links people outside a registration / import (decision 57):
 * the coordenação PROPOSES, and one current responsável of the kid accepts or
 * declines in the parent area (decision 83). Nothing is linked or shared until
 * then; persons-api expires it after 30 days. Acampa keeps nothing of it — the
 * request lives in persons-api; names pass through to the screen only.
 *
 *   POST /                     {camperId, name, phone, email?} coordenação — the person is
 *                              registered (or found by phone) WITHOUT link / membership, then proposed
 *   GET  /mine                 responsável — pending requests for their kids
 *   POST /:id/accept|decline   responsável — with their own responsável role token
 */
type Env = { Variables: AuthVariables };
const linkRequests = new Hono<Env>();

const NAME_MAX = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

/** what the browser sees: ids, the project name snapshot, dates — names only on the family's own read */
function view(r: LinkRequest) {
  return {
    id: r.id,
    childId: r.childId,
    proposedResponsibleId: r.proposedResponsibleId,
    projectName: r.projectName,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    child: r.child,
    proposedResponsible: r.proposedResponsible,
  };
}

linkRequests.use("*", requireAuth);

// ── the family (responsável) ────────────────────────────────────────────────

linkRequests.get("/mine", requireRole("parent"), async (c) => {
  const items = await coreClient().myLinkRequests(actingToken(c, PERSONS_RESOURCE));
  // a proposal that ended without the family (expired / cancelled) never welcomes anyone later
  for (const r of items) if (r.status === "expired" || r.status === "cancelled") await takeJoinWelcome(r.proposedResponsibleId);
  return c.json({ items: items.filter((r) => r.status === "pending").map(view) });
});

for (const decision of ["accept", "decline"] as const) {
  linkRequests.post(`/:id/${decision}`, requireRole("parent"), async (c) => {
    const request = await coreClient().decideLinkRequest(actingToken(c, PERSONS_RESOURCE), c.req.param("id"), decision);
    console.log(`[link-requests] ${request.id} ${request.status}`);
    // a responsável new to the edition joins it now: welcomed like any family that joins late (marked at the proposal)
    // (declined / expired / cancelled: the mark is cleared — nobody joins)
    if (await takeJoinWelcome(request.proposedResponsibleId)) {
      if (request.status === "accepted") void welcomeLateFamilies([request.proposedResponsibleId]);
    }
    // ids + status only: the names were for the screen that asked
    return c.json({ request: { id: request.id, childId: request.childId, status: request.status } });
  });
}

// ── the coordenação proposes ────────────────────────────────────────────────

linkRequests.post("/", requireManager, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const camperId = typeof body.camperId === "string" ? body.camperId : "";
  const name = typeof body.name === "string" ? titleCaseName(body.name) : "";
  const phone = typeof body.phone === "string" ? normalizeBrazilPhone(body.phone) : null;
  const email = typeof body.email === "string" && body.email.trim() ? body.email.trim().toLowerCase() : null;
  if (!name || name.length > NAME_MAX || !phone) return fail(c, "RESPONSIBLE_INVALID", "Informe o nome e o celular do responsável.");
  if (email && !EMAIL_RE.test(email)) return fail(c, "EMAIL_INVALID", "Confira o e-mail.");
  const kid = camperId ? await findCamperById(camperId) : null;
  if (!kid) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  // the camp role that registers (canRegister) — persons-api re-checks it live
  const token = coordinationToken(c.get("session"), PERSONS_RESOURCE);
  if (!token) return fail(c, "COORDINATION_REQUIRED", "Só a coordenação cadastra pessoas.", 403);
  const responsible = await registerProposedResponsible(token, { name, phone, email });
  if (responsible.personId === kid._id) return fail(c, "RESPONSIBLE_INVALID", "Informe o nome e o celular do responsável.");
  const newFamily = !(await isFamilyOfEdition(responsible.personId));
  let request: LinkRequest;
  try {
    request = await coreClient().proposeLinkRequest(token, { childId: kid._id, responsibleId: responsible.personId });
  } catch (err) {
    // core's reason travels as a code the frontend says gently
    if (err instanceof IpalphaRejected && err.status === 409) return c.json({ error: { code: "LINK_REQUEST_REFUSED", reason: err.reason, message: "O IPAlpha não criou este pedido." } }, 409);
    throw err;
  }
  if (newFamily) await markJoinWelcome(responsible.personId);
  console.log(`[link-requests] ${request.id} proposed for ${kid._id}`);
  return c.json({ request: { id: request.id, childId: request.childId, status: request.status, expiresAt: request.expiresAt }, responsible: { personId: responsible.personId, created: responsible.created } }, 201);
});

export default linkRequests;
