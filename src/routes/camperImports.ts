import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { coordinationContext } from "../services/acting";
import { requireManager } from "../middleware/roles";
import { claimCamperImport, findCamperImport, insertCamperImport, markImportDictionaryPublished, updateCamperImport, upsertImportDictionary } from "../models/camperImports";
import { analyzeCamperImport, applyCategoryChoices, applyImportDelta, createLeaderFromReview, discardImportCategoryOptions, IMPORT_FILE_MAX_BYTES, IMPORT_FIELDS, insertImportCampers, publishImportDrafts } from "../services/camperImport";
import { getImportProgress, setImportProgress } from "../services/importProgress";
import { publish } from "../services/realtime";
import type { CamperImportReviewItem } from "../types";

type Env = { Variables: AuthVariables };

const imports = new Hono<Env>();
const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

function serialize(record: NonNullable<Awaited<ReturnType<typeof findCamperImport>>>) {
  return {
    id: record._id,
    fileName: record.fileName,
    fileType: record.fileType,
    status: record.status,
    dryRun: record.dryRun,
    columns: record.columns,
    dictionaries: record.dictionaries,
    reviews: record.reviews,
    preview: record.preview,
    skipped: record.skipped,
    createdItems: record.createdItems,
    dateFunction: record.dateFunction,
    startedAt: record.startedAt,
    reviewStartedAt: record.reviewStartedAt,
    finishedAt: record.finishedAt,
    error: record.error,
  };
}

imports.use("*", requireAuth, requireManager);

imports.get("/fields", (c) => c.json({ fields: IMPORT_FIELDS.map(({ key, label }) => ({ key, label })) }));

/** multipart: file + optional mapping JSON. Runs the AI-assisted dry-run. */
imports.post("/analyze", async (c) => {
  const body = await c.req.parseBody().catch(() => null);
  const file = body?.file;
  if (!(file instanceof File)) return fail(c, "FILE_REQUIRED", "Escolha um arquivo CSV ou Excel.");
  if (file.size > IMPORT_FILE_MAX_BYTES) return fail(c, "FILE_TOO_LARGE", "A planilha pode ter no máximo 12 MB.");
  const mappingRaw = typeof body?.mapping === "string" ? body.mapping : "";
  const progressId = typeof body?.progress === "string" ? body.progress.slice(0, 64) : "";
  let mapping: Record<string, string | null> | undefined;
  try {
    mapping = mappingRaw ? JSON.parse(mappingRaw) as Record<string, string | null> : undefined;
  } catch {
    return fail(c, "MAPPING_INVALID", "O mapeamento de colunas é inválido.");
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const user = c.get("user");
  const fileHash = sha256(data);
  const startedAt = new Date();
  let record = await insertCamperImport({
    fileName: file.name,
    subject: "camper",
    fileType: file.type,
    fileHash,
    status: "analyzing",
    dryRun: true,
    columns: [], rows: [], dictionaries: [], reviews: [], preview: [], skipped: [], createdItems: [], dateFunction: "",
    startedAt, reviewStartedAt: null, finishedAt: null, finishedSmsSentAt: null, errorSmsSentAt: null, notificationCheckedAt: null,
    createdByPersonId: user.id,
    error: "",
  });
  try {
    const analysis = await analyzeCamperImport({ data, fileName: file.name, fileType: file.type, importId: record._id, mapping, signal: c.req.raw.signal, onProgress: progressId ? (key, pct) => setImportProgress(progressId, key, pct) : undefined });
    record = (await updateCamperImport(record._id, {
      status: analysis.status,
      columns: analysis.columns,
      // The browser sends the original file again on Apply. Keeping all raw
      // rows here only bloats the Mongo document and can hit its 16 MB limit.
      rows: [],
      dictionaries: analysis.dictionaries,
      reviews: analysis.reviews,
      preview: analysis.preview,
      skipped: analysis.skipped,
      createdItems: analysis.createdItems,
      dateFunction: analysis.dateFunction,
      error: analysis.panicMessage,
    }))!;
    // Persist partial knowledge even on mapping/date panic; draft stays hidden from normal system flows.
    await upsertImportDictionary(analysis.dictionaries, record._id);
    setImportProgress(progressId, "done", 100);
    return c.json({ import: serialize(record) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Não foi possível ler a planilha.";
    await updateCamperImport(record._id, { status: "error", error: message });
    return fail(c, "IMPORT_FAILED", message);
  }
});

imports.get("/progress/:token", (c) => c.json({ progress: getImportProgress(c.req.param("token")) }));

imports.get("/:id", async (c) => {
  const record = await findCamperImport(c.req.param("id"));
  return record ? c.json({ import: serialize(record) }) : fail(c, "IMPORT_NOT_FOUND", "Importação não encontrada.", 404);
});

/** Creates a missing leader immediately during review. */
imports.post("/:id/leaders", async (c) => {
  const record = await findCamperImport(c.req.param("id"));
  if (!record) return fail(c, "IMPORT_NOT_FOUND", "Importação não encontrada.", 404);
  if (!["review", "ready"].includes(record.status)) return fail(c, "IMPORT_BLOCKED", "Esta importação não aceita mais novos líderes.", 409);
  const body = await c.req.json<{ reviewId?: string; phone?: string }>().catch(() => null);
  const item = record.reviews.find((r) => r.id === body?.reviewId && r.kind === "leader");
  if (!item) return fail(c, "REVIEW_NOT_FOUND", "Líder não encontrado nesta revisão.", 404);
  const ctx = await coordinationContext(c.get("session"));
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);
  try {
    const staff = await createLeaderFromReview(item.original, body?.phone ?? "", record._id, ctx);
    const canonical = record.dictionaries.find((d) => d.field === "leader" && d.normalized === normalized(item.original))?.label ?? item.original;
    const reviews = record.reviews.map((r) => r.kind === "leader" && normalized(r.original) === normalized(item.original) ? { ...r, value: staff._id, resolved: true } : r);
    const dictionaries = record.dictionaries.map((d) => d.field === "leader" && normalized(d.label) === normalized(canonical) ? { ...d, value: staff._id, label: staff.name } : d);
    const updated = (await updateCamperImport(record._id, { reviews, dictionaries, createdItems: [...record.createdItems, { kind: "staff", id: staff._id, label: staff.name, draft: true }] }))!;
    await upsertImportDictionary(dictionaries, record._id);
    publish("staff");
    return c.json({ staff: { id: staff._id, name: staff.name }, import: serialize(updated) });
  } catch (err) {
    if (!(err instanceof Error) || err.constructor.name !== "Error") throw err;
    return fail(c, "LEADER_INVALID", err.message || "Não foi possível criar o líder.");
  }
});

/** Original file + review delta: deterministic final run, insert, queue AI triage. */
imports.post("/:id/apply", async (c) => {
  const record = await findCamperImport(c.req.param("id"));
  if (!record) return fail(c, "IMPORT_NOT_FOUND", "Importação não encontrada.", 404);
  if (record.status === "panic" || record.status === "needs_mapping") return fail(c, "IMPORT_BLOCKED", record.error || "Corrija a planilha antes de aplicar.", 409);
  if (!["ready", "review"].includes(record.status)) return fail(c, "IMPORT_ALREADY_APPLIED", record.status === "completed" ? "Esta planilha já foi aplicada." : "Esta importação já está em andamento.", 409);
  const body = await c.req.parseBody().catch(() => null);
  const file = body?.file;
  if (!(file instanceof File)) return fail(c, "FILE_REQUIRED", "Envie novamente a planilha original.");
  if (file.size > IMPORT_FILE_MAX_BYTES) return fail(c, "FILE_TOO_LARGE", "A planilha pode ter no máximo 12 MB.");
  const data = new Uint8Array(await file.arrayBuffer());
  if (record.fileHash && sha256(data) !== record.fileHash) return fail(c, "FILE_CHANGED", "A planilha mudou desde a prévia. Analise o novo arquivo antes de aplicar.", 409);
  let delta: Record<string, { value?: string; skip?: boolean }> = {};
  let declinedCategoryIds: string[] = [];
  let duplicateChoice:"update"|"keep"|"merge"|""="";
  try {
    delta = typeof body?.delta === "string" ? JSON.parse(body.delta) : {};
    const parsed = typeof body?.declinedCategoryIds === "string" ? JSON.parse(body.declinedCategoryIds) : [];
    declinedCategoryIds = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    duplicateChoice=body?.duplicateChoice==="update"||body?.duplicateChoice==="keep"||body?.duplicateChoice==="merge"?body.duplicateChoice:"";
  }
  catch { return fail(c, "DELTA_INVALID", "As correções da revisão são inválidas."); }
  const allowedCategoryIds = new Set(record.createdItems.filter((item) => item.kind === "categoryOption").map((item) => item.id));
  declinedCategoryIds = [...new Set(declinedCategoryIds.filter((id) => allowedCategoryIds.has(id)))];
  const camperReviews = record.reviews as CamperImportReviewItem[];
  if(duplicateChoice)for(const review of camperReviews)if(review.kind==="duplicate"&&!delta[review.id]?.value)delta[review.id]={...delta[review.id],value:duplicateChoice};
  const chosenPreview = applyCategoryChoices(record.preview, declinedCategoryIds);
  const { rows, skipped: reviewSkipped } = applyImportDelta(chosenPreview, camperReviews, delta);
  const ctx = await coordinationContext(c.get("session"));
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);
  if (!(await claimCamperImport(record._id))) return fail(c, "IMPORT_ALREADY_APPLIED", "Esta importação já está em andamento ou foi aplicada.", 409);
  try {
    const result = await insertImportCampers(rows, record._id, ctx);
    const finishedAt = new Date();
    // insertImportCampers is the final authority; reviewSkipped is useful only
    // when it adds context that the final validation did not already report.
    const skippedByRow = new Map<number, Record<string, unknown>>();
    for (const item of [...reviewSkipped, ...result.skipped]) skippedByRow.set(Number(item.row), item);
    const skipped = [...skippedByRow.values()];
    const reviews: CamperImportReviewItem[] = camperReviews.map((r) => ({ ...r, value: delta[r.id]?.value ?? r.value, skip: delta[r.id]?.skip ?? r.skip, resolved: true }));
    // the spreadsheet's person data is not kept once applied (it lives in core now): rows / preview are dropped
    const updated = (await updateCamperImport(record._id, { status: "completed", dryRun: false, reviews: reviews.map((r) => ({ ...r, existingData: undefined, incomingData: undefined, mergedData: undefined })), skipped, finishedAt, error: "", rows: [], preview: [] }))!;
    await discardImportCategoryOptions(record._id, declinedCategoryIds);
    await Promise.all([markImportDictionaryPublished(record._id), publishImportDrafts(record._id)]);
    publish("campers", "bedrooms", "staff", "teams", "transports", "categories");
    return c.json({ import: serialize(updated), inserted: result.inserted, skipped: skipped.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "A importação parou durante a gravação.";
    await updateCamperImport(record._id, { status: "error", error: message });
    return fail(c, "IMPORT_FAILED", `${message} Nenhuma nova tentativa foi feita para evitar duplicidades.`, 409);
  }
});

export default imports;
