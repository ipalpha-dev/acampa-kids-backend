import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireManager } from "../middleware/roles";
import { findImportJob, FINAL_IMPORT_STATUSES } from "../models/importJobs";
import { campEditionId, coordinationToken } from "../services/acting";
import { coreClient } from "../services/ipalpha";
import { IpalphaRejected, PERSONS_RESOURCE, PROJECTS_RESOURCE } from "../services/ipalpha/coreClient";
import {
  appFieldsFor,
  campOfEdition,
  catchUpImport,
  IMPORT_FILE_MAX_BYTES,
  IMPORT_FILE_TYPES,
  IMPORT_SUBJECTS,
  importTargets,
  importView,
  parseDecisions,
  rememberSubject,
  runInImportQueue,
  subjectOf,
  subjectOfTargets,
  trackImport,
  type ImportSubject,
} from "../services/personImports";

/**
 * /api/imports — spreadsheet imports through persons-api (CONTRACTS §20/§24).
 * A thin proxy: every call goes to persons-api with the importer's
 * COORDENAÇÃO role token (never stored), Acampa adds its `appFields` and
 * `targets` and applies the results to `participants` (services/personImports.ts).
 * Only the person who started an import follows it (persons-api answers
 * `403 notImportOwner` to anyone else).
 *
 *   GET    /app-fields?subject=camper|team   what Acampa asks persons-api to fill
 *   POST   /            multipart file + subject → {import}
 *   GET    /:id         {import} (+ catches up batches a lost message left behind)
 *   PATCH  /:id         {mapping?, reviews?:[{id, choice?, value?, rows?}]} → {import}
 *   POST   /:id/apply   → {import}; 409 DECISIONS_PENDING {pending:[{id, kind, field?}]}
 *   DELETE /:id         cancel (rows wiped in core; applied batches stay)
 *   GET    /:id/results?cursor=<batch>   batches: ids + app field values only
 */
type Env = { Variables: AuthVariables };
const imports = new Hono<Env>();

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

imports.use("*", requireAuth, requireManager);

function subjectParam(v: unknown): ImportSubject | null {
  return (IMPORT_SUBJECTS as readonly unknown[]).includes(v) ? (v as ImportSubject) : null;
}

/** The importer's coordenação token for `audience`, or the 403 answer. */
function tokenOf(c: Context<Env>, audience: typeof PERSONS_RESOURCE | typeof PROJECTS_RESOURCE = PERSONS_RESOURCE): string | Response {
  return coordinationToken(c.get("session"), audience) ?? fail(c, "COORDINATION_REQUIRED", "Só a coordenação importa planilhas no IPAlpha.", 403);
}

imports.get("/app-fields", async (c) => {
  const subject = subjectParam(c.req.query("subject"));
  if (!subject) return fail(c, "SUBJECT_INVALID", "Escolha crianças ou equipe.");
  return c.json({ subject, appFields: await appFieldsFor(subject) });
});

imports.post("/", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  const body = await c.req.parseBody().catch(() => null);
  const subject = subjectParam(body?.subject);
  if (!subject) return fail(c, "SUBJECT_INVALID", "Escolha crianças ou equipe.");
  const file = body?.file;
  if (!(file instanceof File) || file.size === 0) return fail(c, "FILE_REQUIRED", "Escolha um arquivo CSV ou Excel.");
  if (file.size > IMPORT_FILE_MAX_BYTES) return fail(c, "FILE_TOO_LARGE", "A planilha pode ter no máximo 5 MB.");
  if (!IMPORT_FILE_TYPES.test(file.name)) return fail(c, "FILE_TYPE_INVALID", "Envie um arquivo .csv ou .xlsx.");
  const editionId = await campEditionId();
  if (!editionId) return fail(c, "EDITION_UNKNOWN", "A edição deste acampamento ainda não existe no IPAlpha.", 409);
  const appFields = await appFieldsFor(subject);
  const client = coreClient();
  const created = await client.createImport(token, { file, fileName: file.name, editionId, targets: importTargets(subject), appFields });
  const session = c.get("session");
  await trackImport({ importId: created.importId, campId: session.campId, startedBy: session.personId, status: created.status, subject });
  console.log(`[imports] ${created.importId} started (${subject})`);
  // the job right away (steps / file); a refusal to read it now still leaves the import going
  const job = await client.getImport(token, created.importId).catch(() => ({ id: created.importId, status: created.status, targets: importTargets(subject) }));
  return c.json({ import: { ...importView(job, appFields), subject } }, 201);
});

/**
 * The job + Acampa's app fields. When persons-api holds batches this side
 * has not applied yet (or the import ended), they are caught up right here
 * with the importer's own token (decisions 64 / 77).
 */
async function readView(c: Context<Env>, token: string, id: string) {
  const job = await coreClient().getImport(token, id);
  const subject = subjectOf(id) ?? subjectOfTargets(job.targets);
  rememberSubject(id, subject);
  const appFields = subject ? await appFieldsFor(subject) : [];
  let view = importView(job, appFields);
  let tracked = await findImportJob(id);
  if (!tracked && subject) {
    // started before Acampa kept `importJobs`: the importer reading it is the one who started it (persons-api checks)
    const session = c.get("session");
    tracked = await trackImport({ importId: id, campId: await campOfEdition(typeof job.editionId === "string" ? job.editionId : null), startedBy: session.personId, status: view.status, subject });
  }
  if (tracked && !FINAL_IMPORT_STATUSES.has(tracked.status) && (view.counts.batches > tracked.lastBatch || FINAL_IMPORT_STATUSES.has(view.status))) {
    await runInImportQueue(() => catchUpImport(id, token));
    tracked = await findImportJob(id);
  }
  view = { ...view, applied: { batches: tracked?.lastBatch ?? 0 } };
  return view;
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
  const subject = subjectOf(id) ?? subjectOfTargets((await coreClient().getImport(token, id)).targets);
  rememberSubject(id, subject);
  const fields = subject ? await appFieldsFor(subject) : [];
  const parsed = parseDecisions(raw, fields);
  if (!parsed.ok) return fail(c, "DECISIONS_INVALID", parsed.message);
  const job = await coreClient().patchImport(token, id, parsed.decisions);
  const tracked = await findImportJob(id);
  return c.json({ import: { ...importView(job, fields), applied: { batches: tracked?.lastBatch ?? 0 } } });
});

imports.post("/:id/apply", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  const projectsToken = tokenOf(c, PROJECTS_RESOURCE);
  if (projectsToken instanceof Response) return projectsToken;
  const id = c.req.param("id");
  try {
    await coreClient().applyImport(token, projectsToken, id);
  } catch (err) {
    if (err instanceof IpalphaRejected && err.status === 409 && err.reason === "decisionsPending") {
      const pending = (Array.isArray(err.body.pending) ? err.body.pending : [])
        .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : {}))
        .filter((p) => typeof p.id === "string")
        .map((p) => ({ id: p.id as string, kind: typeof p.kind === "string" ? p.kind : "review", ...(typeof p.field === "string" ? { field: p.field } : {}) }));
      return c.json({ error: { code: "DECISIONS_PENDING", reason: "decisionsPending", message: "Ainda há decisões a tomar antes de gravar.", pending } }, 409);
    }
    throw err;
  }
  return c.json({ import: await readView(c, token, id) });
});

imports.delete("/:id", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  const id = c.req.param("id");
  await coreClient().cancelImport(token, id);
  // batches applied before the cancel stay in persons-api: read what is missing, then the entry ends
  if (await findImportJob(id)) await runInImportQueue(() => catchUpImport(id, token)).catch(() => undefined);
  return c.json({ success: true });
});

imports.get("/:id/results", async (c) => {
  const token = tokenOf(c);
  if (token instanceof Response) return token;
  const raw = c.req.query("cursor");
  const cursor = raw ? Number(raw) : undefined;
  if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 1)) return fail(c, "CURSOR_INVALID", "Lote inválido.");
  const page = await coreClient().importBatches(token, c.req.param("id"), { cursor, limit: 10 });
  return c.json({ items: page.items, nextCursor: page.nextCursor });
});

export default imports;
