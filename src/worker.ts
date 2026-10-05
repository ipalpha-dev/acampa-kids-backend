import { config } from "./config";
import { getDb } from "./db";
import { activeCampId, refreshActiveCamp, withCamp } from "./services/campContext";
import { claimCampersForAiReview, claimCampersForCleanup, finishCamperAiReview, finishCamperStructure, requeueStaleAiReviews, updateCamper } from "./models/campers";
import { claimStaffForAiReview, claimStaffForCleanup, finishStaffAiReview, finishStaffStructure, requeueStaleStaffAiReviews, updateStaff } from "./models/staff";
import { AI_REVIEW_MAX_ATTEMPTS, aiReviewExhaustedFilter, aiReviewRetryDelayMs, aiReviewRetryPendingFilter, formatRetryDelay } from "./models/aiReviewRetry";
import { findCamperImport, listImportsPendingNotification, updateCamperImport } from "./models/camperImports";
import { recordAiUsage } from "./models/aiUsage";
import { appendCategoryOption, listCategories, newOptionId } from "./models/categories";
import { enqueueHealth, listHealthQueue } from "./models/healthQueue";
import { structureImportHealthWithJev } from "./services/importHealthStructureAi";
import { CAMPER_CATEGORY_KEYS, type HealthInfo } from "./types";
import { cleanupImportObservations, type HealthOption, type HealthOptions, type ImportHealthSelection } from "./services/importObservationCleanupAi";
import { superAdminIds } from "./middleware/auth";
import { sendMessage } from "./services/messages";
import type { RawNotesCall } from "./services/camperNotesAi";
import type { Camper, Staff } from "./types";

/**
 * Background AI triage of imported observations. The worker holds NO person
 * token: it reads only Acampa's own free-text observations (`generalNotes`),
 * writes the cleaned text back there, and leaves the structured HEALTH result
 * in the transient `healthQueue`, which a coordenação session writes to
 * persons-api (POST /api/people/health-queue/flush). Logs carry ids only.
 */
const POLL_MS = 10_000;
const BATCH = 15;
const SLOW_IMPORT_MS = 5 * 60_000;
/** idle heartbeat: remind the terminal the worker is alive every ~5 min */
const IDLE_HEARTBEAT_POLLS = 30;

const stamp = () => new Date().toISOString();
function log(tag: string, msg: string): void {
  console.log(`[${stamp()}] [worker:${tag}] ${msg}`);
}
/** "retry 2/5 in 30min" or "exhausted after 5 attempts, needs manual review" */
function retryNote(attempts: number): string {
  if (attempts >= AI_REVIEW_MAX_ATTEMPTS) return `exhausted after ${attempts} attempts, needs manual review`;
  return `retry ${attempts + 1}/${AI_REVIEW_MAX_ATTEMPTS} in ${formatRetryDelay(aiReviewRetryDelayMs(attempts))}`;
}

const backendUrl = (process.env.BACKEND_URL ?? `http://localhost:${config.port}`).replace(/\/$/, "");
if (!config.worker.secret) log("startup", "WORKER_SECRET empty — backend notify disabled, websocket event will not fire");
/** every active, non-draft configured health option (ids + labels) the cleanup model may select */
async function healthOptions(): Promise<HealthOptions> {
  const categories = await listCategories();
  const options = (key: string): HealthOption[] =>
    categories.find((c) => c.key === key)?.options.filter((o) => o.active && !o.draft && !/^nenhum/i.test(o.label) && !/^(?:outro|outros|outra|outras)\b/i.test(o.label)).map((o) => ({ id: o.id, label: o.label })) ?? [];
  return { allergies: options(CAMPER_CATEGORY_KEYS.allergies), drugAllergies: options(CAMPER_CATEGORY_KEYS.drugAllergies), healthIssues: options(CAMPER_CATEGORY_KEYS.healthIssues) };
}

/**
 * Applies the cleanup model's final health classification: labels no option
 * covers become real (active) category options, linked to the record right
 * away. Returns the final id lists. Shared by campers and staff.
 */
async function applyHealthSelection(health: ImportHealthSelection, importId: string | null | undefined, who: string): Promise<{ allergies: string[]; drugAllergies: string[]; healthIssues: string[]; created: number }> {
  const out = { allergies: [...health.allergies], drugAllergies: [...health.drugAllergies], healthIssues: [...health.healthIssues], created: 0 };
  const total = health.newOptions.allergies.length + health.newOptions.drugAllergies.length + health.newOptions.healthIssues.length;
  if (!total) return out;
  const categories = await listCategories();
  for (const field of ["allergies", "drugAllergies", "healthIssues"] as const) {
    const cat = categories.find((c) => c.key === CAMPER_CATEGORY_KEYS[field]);
    if (!cat) continue;
    for (const label of health.newOptions[field]) {
      // the option may have been created by a sibling record in the same batch — reuse it
      const existing = cat.options.find((o) => o.label.localeCompare(label, "pt-BR", { sensitivity: "base" }) === 0);
      if (existing) {
        if (!out[field].includes(existing.id)) out[field].push(existing.id);
        continue;
      }
      const option = { id: newOptionId(), label, order: cat.options.length, active: true, ...(importId ? { importId } : {}) };
      if (!(await appendCategoryOption(cat._id, option))) continue;
      cat.options.push(option);
      out[field].push(option.id);
      out.created++;
      log("health", `${who} — new option "${label}" → category "${cat.name}"`);
    }
  }
  return out;
}

/**
 * Tells the main backend one record reached a review checkpoint — "structured"
 * right after the fast Jev pass (fields already updated), "reviewed"/"error"
 * at the end — so it can push the websocket event (the worker process itself
 * holds no sockets). Best-effort: a failed callback never fails the review,
 * it only logs.
 */
async function notifyBackend(kind: "camper" | "staff", id: string, status: "structured" | "reviewed" | "error", attempts: number, newOptions = false): Promise<void> {
  if (!config.worker.secret) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${backendUrl}/api/worker/reviewed`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.worker.secret}` },
      body: JSON.stringify({ kind, id, status, attempts, newOptions }),
      signal: ctrl.signal,
    });
    log("notify", `${kind} ${id} — backend callback ${res.ok ? "ok" : `FAILED (http ${res.status})`}`);
  } catch (err) {
    log("notify", `${kind} ${id} — backend callback FAILED (${err instanceof Error ? err.message : "unreachable"})`);
  } finally {
    clearTimeout(timer);
  }
}

/** one line per model attempt inside a record review (failures stay visible) */
function attemptLogger(who: string): (model: string, r: RawNotesCall) => void {
  return (model, r) => {
    void recordAiUsage({ at: new Date(), vendor: model.startsWith("grok") ? "xai" : model.startsWith("claude") ? "anthropic" : "openai", model, kind: "camper_notes", userId: "worker", ...r.usage, ok: r.ok });
    log("ai", `${who} — model=${model} ok=${r.ok} tokens=${r.usage.promptTokens}+${r.usage.completionTokens}${r.ok ? "" : ` error=${r.error ?? "unknown"}`}`);
  };
}

/** the queued (not yet written) health patch of a person, as the base the next pass builds on */
async function queuedPatch(personId: string): Promise<Partial<HealthInfo>> {
  return (await listHealthQueue(1000)).find((q) => q.personId === personId)?.patch ?? {};
}

type Subject = { kind: "camper"; row: Camper } | { kind: "staff"; row: Staff };

/** phase 1 — Jev pre-fill (near-instant): obvious closed health fields from the observations → health queue */
async function structureOne(item: Subject): Promise<void> {
  const { kind, row } = item;
  const who = `${kind} ${row._id}`;
  try {
    const notes = row.generalNotes.trim();
    log(kind, `${who} — start, observations=${notes.length} chars`);
    const jev = await structureImportHealthWithJev(notes, { allergies: [], drugAllergies: [], healthIssues: [], neurodivergent: false }, kind);
    void recordAiUsage({ at: new Date(), vendor: jev.vendor, model: jev.model, kind: "structure_health", userId: "worker", ...jev.usage, ok: jev.ok });
    if (!jev.ok) throw new Error(`Jev: ${jev.error ?? "falhou"}`);
    log(kind, `${who} — Jev structured: allergies=${jev.allergies.length} drugAllergies=${jev.drugAllergies.length} healthIssues=${jev.healthIssues.length}`);
    await enqueueHealth({ personId: row._id, kind: kind === "camper" ? "camper" : "team", importId: row.importId, patch: { allergies: jev.allergies, drugAllergies: jev.drugAllergies, healthIssues: jev.healthIssues, ...(kind === "camper" ? { neurodivergent: jev.neurodivergent } : {}) } });
    if (kind === "camper") await finishCamperStructure(row._id);
    else await finishStaffStructure(row._id);
    await notifyBackend(kind, row._id, "structured", 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha na revisão por IA.";
    const attempts = kind === "camper" ? ((await finishCamperStructure(row._id, message))?.aiReviewAttempts ?? 1) : await finishStaffStructure(row._id, message);
    log(kind, `${who} — ERROR: ${message} — ${retryNote(attempts)}`);
    if (attempts >= AI_REVIEW_MAX_ATTEMPTS) await notifyBackend(kind, row._id, "error", attempts);
  }
}

/** phase 2 — slow generative review: final health selection + cleaned observations */
async function cleanupOne(item: Subject): Promise<void> {
  const { kind, row } = item;
  const who = `${kind} ${row._id}`;
  try {
    const base = await queuedPatch(row._id);
    const cleanup = await cleanupImportObservations({
      notes: row.generalNotes.trim(),
      subject: kind,
      options: await healthOptions(),
      structured: { allergies: base.allergies ?? [], drugAllergies: base.drugAllergies ?? [], healthIssues: base.healthIssues ?? [], neurodivergent: base.neurodivergent ?? false, medications: [] },
      // the camp-ops fields Acampa owns are the only "current" values the worker can see
      current: { email: "", ...(kind === "camper" ? { bedroomPreference: (row as Camper).bedroomPreference } : {}) },
    });
    void recordAiUsage({ at: new Date(), vendor: cleanup.vendor, model: cleanup.model, kind: "normalize_observations", userId: "worker", ...cleanup.usage, ok: cleanup.ok });
    if (!cleanup.ok) throw new Error(`Cleanup: ${cleanup.error ?? "falhou"}`);
    const health = await applyHealthSelection(cleanup.health, row.importId, who);
    const r = cleanup.recovered;
    const patch: Partial<HealthInfo> = {
      allergies: health.allergies,
      drugAllergies: health.drugAllergies,
      healthIssues: health.healthIssues,
      ...(kind === "camper" ? { neurodivergent: cleanup.health.neurodivergent } : {}),
      medications: cleanup.medications,
      foodRestrictions: cleanup.foodRestrictions,
      healthNotes: cleanup.healthNotes,
      ...(r.insurance ? { insurance: r.insurance } : {}),
      ...(r.insuranceCard ? { insuranceCard: r.insuranceCard } : {}),
      ...(r.weightKg != null ? { weightKg: r.weightKg } : {}),
    };
    await enqueueHealth({ personId: row._id, kind: kind === "camper" ? "camper" : "team", importId: row.importId, patch });
    if (kind === "camper") {
      await updateCamper(row._id, { generalNotes: cleanup.generalNotes, ...(r.bedroomPreference && !(row as Camper).bedroomPreference ? { bedroomPreference: r.bedroomPreference } : {}) });
      await finishCamperAiReview(row._id);
    } else {
      await updateStaff(row._id, { generalNotes: cleanup.generalNotes });
      await finishStaffAiReview(row._id);
    }
    log(kind, `${who} — done (health queued for the coordenação to write)`);
    await notifyBackend(kind, row._id, "reviewed", 0, health.created > 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha na revisão por IA.";
    const attempts = kind === "camper" ? ((await finishCamperAiReview(row._id, message))?.aiReviewAttempts ?? 1) : await finishStaffAiReview(row._id, message);
    log(kind, `${who} — ERROR: ${message} — ${retryNote(attempts)}`);
    if (attempts >= AI_REVIEW_MAX_ATTEMPTS) await notifyBackend(kind, row._id, "error", attempts);
  }
}

/** last "waiting" count per import, so the cooldown hours don't spam the terminal */
const notifyRemaining = new Map<string, number>();

async function notifyFinishedImports(importIds: string[]): Promise<void> {
  const db = await getDb();
  for (const importId of [...new Set(importIds.filter(Boolean))]) {
    const [remainingRows, retryRows] = await Promise.all([
      db.collection("participants").countDocuments({ importId, aiReviewStatus: { $in: ["pending", "processing", "structured"] } }),
      db.collection("participants").countDocuments({ importId, ...aiReviewRetryPendingFilter() }),
    ]);
    const remaining = remainingRows + retryRows;
    if (remaining > 0) {
      // errors with tries left are still working (cooldown) — log only when the count changes
      if (notifyRemaining.get(importId) !== remaining) {
        notifyRemaining.set(importId, remaining);
        log("notify", `import ${importId} — waiting, ${remaining} review(s) left (${retryRows} in cooldown)`);
      }
      continue;
    }
    notifyRemaining.delete(importId);
    const record = await findCamperImport(importId);
    if (!record || record.status !== "completed") continue;
    const [total, errors] = await Promise.all([
      db.collection("participants").countDocuments({ importId }),
      db.collection("participants").countDocuments({ importId, ...aiReviewExhaustedFilter() }),
    ]);
    const errorRate = total ? errors / total : 0;
    const reviewStartedAt = record.reviewStartedAt ?? record.finishedAt ?? record.startedAt;
    const slowReview = Date.now() - reviewStartedAt.getTime() > SLOW_IMPORT_MS;
    let notificationFailed = false;
    const patch: Parameters<typeof updateCamperImport>[1] = {};
    log("notify", `import ${importId} — review finished: ${total - errors}/${total} ok, ${errors} error(s)`);
    // a slow review → whoever started the import; >10% errors → the deployment owners (templates, by person id)
    if (slowReview && record.createdByPersonId && !record.finishedSmsSentAt) {
      const sent = await sendMessage("importFinished", [{ personId: record.createdByPersonId, variables: { count: total - errors } }], "import-finished");
      log("notify", `import ${importId} — finished message ${sent?.sent ? "sent" : "FAILED"}`);
      if (sent?.sent) patch.finishedSmsSentAt = new Date();
      else notificationFailed = true;
    }
    const owners = superAdminIds();
    if (errorRate > 0.1 && owners.length && !record.errorSmsSentAt) {
      const sent = await sendMessage("importErrors", owners.map((personId) => ({ personId, variables: { failed: errors, total } })), "import-errors");
      log("notify", `import ${importId} — error-rate message ${sent?.sent ? "sent" : "FAILED"}`);
      if (sent?.sent) patch.errorSmsSentAt = new Date();
      else notificationFailed = true;
    }
    if (!notificationFailed) patch.notificationCheckedAt = new Date();
    await updateCamperImport(importId, patch);
  }
}

/** One poll, scoped to the ACTIVE camp (imports only ever run there). Returns true when nothing was pending. */
async function pollOnce(): Promise<boolean> {
  await refreshActiveCamp(); // cheap — picks up a camp created by the API process within one poll
  return withCamp(activeCampId(), async () => {
    // phase 1 — Jev only, near-instant: its own batch so the slow cleanup never holds it back
    const structure = await Promise.all([claimCampersForAiReview(BATCH), claimStaffForAiReview(BATCH)]);
    if (structure[0].length || structure[1].length) {
      log("jev", `structuring ${structure[0].length} camper(s) + ${structure[1].length} staff review(s)`);
      await Promise.all([...structure[0].map((row) => structureOne({ kind: "camper", row })), ...structure[1].map((row) => structureOne({ kind: "staff", row }))]);
      log("jev", `structured ${structure[0].length} camper(s) + ${structure[1].length} staff review(s)`);
    }
    // phase 2 — slow generative cleanup: separate batch over the already-structured records
    const cleanupBatch = await Promise.all([claimCampersForCleanup(BATCH), claimStaffForCleanup(BATCH)]);
    if (cleanupBatch[0].length || cleanupBatch[1].length) {
      log("cleanup", `cleaning ${cleanupBatch[0].length} camper(s) + ${cleanupBatch[1].length} staff review(s)`);
      await Promise.all([...cleanupBatch[0].map((row) => cleanupOne({ kind: "camper", row })), ...cleanupBatch[1].map((row) => cleanupOne({ kind: "staff", row }))]);
      log("cleanup", `cleaned ${cleanupBatch[0].length} camper(s) + ${cleanupBatch[1].length} staff review(s)`);
    }
    const touched = [...structure.flat(), ...cleanupBatch.flat()];
    if (!touched.length) {
      await notifyFinishedImports((await listImportsPendingNotification()).map((r) => r._id));
      return true;
    }
    await notifyFinishedImports(touched.map((x) => x.importId ?? ""));
    return false;
  });
}

async function loop(): Promise<never> {
  await getDb();
  await refreshActiveCamp();
  const [requeued, requeuedStaff] = await withCamp(activeCampId(), () => Promise.all([requeueStaleAiReviews(), requeueStaleStaffAiReviews()]));
  if (requeued + requeuedStaff) log("startup", `requeued ${requeued} camper and ${requeuedStaff} staff review(s)`);
  await withCamp(activeCampId(), async () => notifyFinishedImports((await listImportsPendingNotification()).map((r) => r._id)));
  log("startup", `import worker ready; jev+cleanup batch=${BATCH}, poll=${POLL_MS / 1000}s`);
  let idlePolls = 0;
  while (true) {
    const idle = await pollOnce();
    if (idle) {
      idlePolls++;
      if (idlePolls % IDLE_HEARTBEAT_POLLS === 0) log("idle", `nothing pending (${idlePolls} empty polls) — worker alive`);
      await Bun.sleep(POLL_MS);
    } else {
      idlePolls = 0;
    }
  }
}

await loop();
