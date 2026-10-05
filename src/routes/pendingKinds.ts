import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireRole } from "../middleware/roles";
import { campEditionId, responsibleToken } from "../services/acting";
import { coreClient } from "../services/ipalpha";
import { IpalphaRejected, isSharedDataKind, PROJECTS_RESOURCE, toSharedKinds, type PendingKindsView, type SharedDataKind } from "../services/ipalpha/coreClient";
import { forgetKidsOf } from "../services/members";
import { rekeySessionSockets } from "../services/realtime";
import type { Session } from "../types";

/**
 * /api/pending-kinds — what the camp asks of the FAMILY about themselves that they have not confirmed yet
 * (decision 87). A responsável added by an accepted link request (decision 86) joins the kid's membership with
 * EMPTY kinds: nothing about them is shared until THEY confirm here. Both routes forward to projects-api with the
 * session's own `responsavel` token and the camp's edition; Acampa keeps nothing of it.
 *
 *   GET  /          responsável — `{editionId, items, kinds}` (`kinds` = everything confirming shares)
 *   POST /confirm   responsável — `{kinds}` exactly as shown (all-or-nothing); 409 PENDING_CHANGED + the new `kinds`
 */
type Env = { Variables: AuthVariables };
const pendingKinds = new Hono<Env>();

function fail(c: Context, code: string, message: string, status: 400 | 403 | 409) {
  return c.json({ error: { code, message } }, status);
}

/** ids + kinds only: what the browser needs to say it in friendly words */
function view(v: PendingKindsView) {
  return {
    editionId: v.editionId,
    items: v.items.map((i) => ({ membershipId: i.membershipId, kind: i.kind, personId: i.personId, role: i.role, editionId: i.editionId, granted: i.granted, requested: i.requested })),
    kinds: v.kinds,
  };
}

const notResponsible = (c: Context) => fail(c, "RESPONSIBLE_REQUIRED", "Só os responsáveis confirmam o que compartilham.", 403);

pendingKinds.use("*", requireAuth);

pendingKinds.get("/", requireRole("parent"), async (c) => {
  const session = c.get("session");
  const token = responsibleToken(session, PROJECTS_RESOURCE);
  if (!token) return notResponsible(c);
  const editionId = await campEditionId(session.campId);
  // a camp without an IPAlpha edition holds no membership to confirm
  if (!editionId) return c.json({ editionId: null, items: [], kinds: [] });
  const pending = await coreClient().pendingKinds(token, editionId);
  // a kid's membership just listed them (accepted link request): open that kid now, not after the 20 s memo
  if (pending.items.some((i) => i.kind === "involved")) await refreshKids(session);
  return c.json(view(pending));
});

pendingKinds.post("/confirm", requireRole("parent"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const raw = body?.kinds;
  if (!Array.isArray(raw) || raw.length > 20 || !raw.every(isSharedDataKind)) return fail(c, "KINDS_INVALID", "Confira o que foi mostrado e tente de novo.", 400);
  const kinds = [...new Set(raw as SharedDataKind[])];
  const session = c.get("session");
  const token = responsibleToken(session, PROJECTS_RESOURCE);
  if (!token) return notResponsible(c);
  const editionId = await campEditionId(session.campId);
  if (!editionId) return fail(c, "EDITION_UNKNOWN", "A edição deste acampamento ainda não existe no IPAlpha.", 409);
  try {
    const result = await coreClient().confirmPendingKinds(token, { kinds, editionId });
    console.log(`[pending-kinds] confirmed ${result.confirmed} membership(s)`);
    return c.json({ ...view(result), confirmed: result.confirmed });
  } catch (err) {
    // what is pending is not what the family saw: show the new list (consent is never given to something unseen)
    if (err instanceof IpalphaRejected && err.status === 409 && err.reason === "pendingChanged") {
      return c.json({ error: { code: "PENDING_CHANGED", reason: "pendingChanged", kinds: toSharedKinds(err.body.kinds).sort(), message: "O que pedimos para compartilhar mudou. Confira de novo." } }, 409);
    }
    throw err;
  }
});

/** forget the responsável → kids memo and send this session's sockets a fresh snapshot (ids only in memory) */
async function refreshKids(session: Session): Promise<void> {
  forgetKidsOf(session.personId);
  try {
    await rekeySessionSockets({ id: session._id, role: "parent", coreRole: session.activeRole, campId: session.campId });
  } catch (err) {
    console.warn("[pending-kinds] fresh snapshot failed", err instanceof Error ? err.message : err);
  }
}

export default pendingKinds;
