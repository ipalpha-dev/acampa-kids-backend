import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireManager } from "../middleware/roles";
import { campEditionId, coordinationToken } from "../services/acting";
import { coreClient } from "../services/ipalpha";
import { PERSONS_RESOURCE } from "../services/ipalpha/coreClient";
import {
  appFieldsFor,
  appliedOf,
  campOfEdition,
  FINAL_STATUSES,
  IMPORT_FILE_MAX_BYTES,
  IMPORT_FILE_TYPES,
  IMPORT_SUBJECTS,
  importTargets,
  importView,
  parseDecisions,
  reconcileDue,
  reconcileImport,
  subjectOfTargets,
  trackedImport,
  trackImport,
  type ImportSubject,
} from "../services/personImports";

/**
 * /api/imports — spreadsheet imports through persons-api (CONTRACTS §20/§24).
 * A thin proxy: every call goes to persons-api with the importer's
 * COORDENAÇÃO role token (never stored), Acampa adds its `appFields` and
 * `targets` and applies the results to `participants` (services/personImports.ts).
 *
 *   GET    /app-fields?subject=camper|team   what Acampa asks persons-api to fill
 *   POST   /            multipart file + subject → {import}
 *   GET    /:id         {import} (+ reconciles missed batches)
 *   PATCH  /:id         decisions → {import}
 *   POST   /:id/apply   → {import}
 *   DELETE /:id         cancel (rows wiped in core)
 *   GET    /:id/results?cursor   batches: ids + app field values only
 */
type Env = { Variables: AuthVariables };
const imports = new Hono<Env>();

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

imports.use("*", requireAuth, requireManager);

function subjectOf(v: unknown): ImportSubject | null {
  return (IMPORT_SUBJECTS as readonly unknown[]).includes(v) ? (v as ImportSubject) : null;
}

/** The importer's coordenação persons token, or the 403 answer. */
function tokenOf(c: Context<Env>): string | Response {
  return coordinationToken(c.get("session"), PERSONS_RESOURCE) ?? fail(c, "COORDINATION_REQUIRED", "Só a coordenação importa planilhas no IPAlpha.", 403);
}

imports.get("/app-fields", async (c) => {
  const subject = subjectOf(c.req.query("subject"));
  if (!subject) return fail(c, "SUBJECT_INVALID", "Escolha crianças ou equipe.");
  return c.json({ subject, appFields: await appFieldsFor(subject) });
});

imports.post("/", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  const body = await c.req.parseBody().catch(() => null);
  const subject = subjectOf(body?.subject);
  if (!subject) return fail(c, "SUBJECT_INVALID", "Escolha crianças ou equipe.");
  const file = body?.file;
  if (!(file instanceof File) || file.size === 0) return fail(c, "FILE_REQUIRED", "Escolha um arquivo CSV ou Excel.");
  if (file.size > IMPORT_FILE_MAX_BYTES) return fail(c, "FILE_TOO_LARGE", "A planilha pode ter no máximo 5 MB.");
  if (!IMPORT_FILE_TYPES.test(file.name)) return fail(c, "FILE_TYPE_INVALID", "Envie um arquivo .csv ou .xlsx.");
  const editionId = await campEditionId();
  if (!editionId) return fail(c, "EDITION_UNKNOWN", "A edição deste acampamento ainda não existe no IPAlpha.", 409);
  const appFields = await appFieldsFor(subject);
  const job = await coreClient().createImport(token, { file, fileName: file.name, editionId, targets: importTargets(subject), appFields });
  const view = importView(job, appFields);
  if (!view.id) return c.json({ error: { code: "IPALPHA_UNAVAILABLE", message: "O IPAlpha não confirmou a importação." } }, 503);
  const session = c.get("session");
  trackImport({ importId: view.id, campId: session.campId, subject, personId: session.personId, sessionId: session._id });
  console.log(`[imports] ${view.id} started (${subject})`);
  return c.json({ import: { ...view, subject } }, 201);
});

/** The job + Acampa's app fields; reconciles batches a lost message left behind (decision 64). */
async function readView(c: Context<Env>, token: string, id: string) {
  const job = await coreClient().getImport(token, id);
  const subject = trackedImport(id)?.subject ?? subjectOfTargets(job.targets);
  const appFields = subject ? await appFieldsFor(subject) : [];
  const view = importView(job, appFields);
  if (reconcileDue(id, view.status)) {
    const session = c.get("session");
    if (!trackedImport(id) && subject) trackImport({ importId: id, campId: await campOfEdition(typeof job.editionId === "string" ? job.editionId : null), subject, personId: session.personId, sessionId: session._id });
    const t = trackedImport(id);
    await reconcileImport(id, token, { campId: t?.campId ?? session.campId, subject, personId: session.personId, final: FINAL_STATUSES.has(view.status) });
  }
  return { ...view, applied: appliedOf(id) };
}

imports.get("/:id", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  return c.json({ import: await readView(c, token, c.req.param("id")) });
});

imports.patch("/:id", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => null);
  const subject = trackedImport(id)?.subject ?? subjectOfTargets((await coreClient().getImport(token, id)).targets);
  const fields = subject ? await appFieldsFor(subject) : [];
  const parsed = parseDecisions(raw, fields);
  if (!parsed.ok) return fail(c, "DECISIONS_INVALID", parsed.message);
  const job = await coreClient().patchImport(token, id, parsed.decisions);
  return c.json({ import: { ...importView(job, fields), applied: appliedOf(id) } });
});

imports.post("/:id/apply", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  const id = c.req.param("id");
  const job = await coreClient().applyImport(token, id);
  const subject = trackedImport(id)?.subject ?? subjectOfTargets(job.targets);
  const session = c.get("session");
  // whoever applies hears the progress (and their token reconciles)
  if (subject) trackImport({ importId: id, campId: trackedImport(id)?.campId ?? session.campId, subject, personId: session.personId, sessionId: session._id });
  return c.json({ import: { ...importView(job, subject ? await appFieldsFor(subject) : []), applied: appliedOf(id) } });
});

imports.delete("/:id", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  await coreClient().cancelImport(token, c.req.param("id"));
  return c.json({ success: true });
});

imports.get("/:id/results", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  const page = await coreClient().importBatches(token, c.req.param("id"), { cursor: c.req.query("cursor") || undefined, limit: 10 });
  return c.json({ items: page.items, nextCursor: page.nextCursor });
});

export default imports;
