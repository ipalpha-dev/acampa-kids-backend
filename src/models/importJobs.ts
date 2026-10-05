import { rawDb } from "../db";

/**
 * `importJobs` (decision 77, approved shape — ids only): the persons-api imports
 * Acampa started, so a restart or a lost dispatch message never leaves batches
 * behind. `{_id: importId, campId, startedBy (personId), status, lastBatch}`:
 *
 *   status     persons-api's status as last seen; a FINAL one (done / failed /
 *              cancelled) is written only after every batch was read
 *   lastBatch  the last batch applied to `participants` (batches are 1-based)
 *
 * Nothing else: no file, no rows, no names. Global (the camp is a field), so
 * one boot / reconnect catch-up sees every camp's open imports. Retention:
 * finished entries go once persons-api dropped the import (30 days — the
 * import id is a Mongo ObjectId, its creation time says when).
 */
const COLLECTION = "importJobs";

export const FINAL_IMPORT_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
/** persons-api keeps an import 30 days; one more day of margin */
const RETENTION_MS = 31 * 24 * 3600_000;

export interface ImportJob {
  importId: string;
  campId: string;
  startedBy: string;
  status: string;
  lastBatch: number;
}

function toJob(doc: Record<string, unknown> | null): ImportJob | null {
  if (!doc) return null;
  return {
    importId: String(doc._id),
    campId: String(doc.campId ?? ""),
    startedBy: String(doc.startedBy ?? ""),
    status: typeof doc.status === "string" ? doc.status : "analysing",
    lastBatch: typeof doc.lastBatch === "number" && doc.lastBatch >= 0 ? doc.lastBatch : 0,
  };
}

/** Records a new import (idempotent: an existing entry is left as is). */
export async function createImportJob(input: { importId: string; campId: string; startedBy: string; status: string }): Promise<ImportJob> {
  const db = await rawDb();
  await db
    .collection(COLLECTION)
    .updateOne({ _id: input.importId as never }, { $setOnInsert: { campId: input.campId, startedBy: input.startedBy, status: input.status, lastBatch: 0 } }, { upsert: true });
  return (await findImportJob(input.importId))!;
}

export async function findImportJob(importId: string): Promise<ImportJob | null> {
  const db = await rawDb();
  return toJob((await db.collection(COLLECTION).findOne({ _id: importId as never })) as Record<string, unknown> | null);
}

/** persons-api's latest status. A final one only through `finishImportJob` (after the last batch was read). */
export async function setImportJobStatus(importId: string, status: string): Promise<void> {
  if (FINAL_IMPORT_STATUSES.has(status)) return;
  const db = await rawDb();
  await db.collection(COLLECTION).updateOne({ _id: importId as never }, { $set: { status } });
}

export async function finishImportJob(importId: string, status: string): Promise<void> {
  const db = await rawDb();
  await db.collection(COLLECTION).updateOne({ _id: importId as never }, { $set: { status } });
}

/** Batch `to` applied: moves `lastBatch` forward, only from `from` (true when this call moved it). */
export async function advanceImportJob(importId: string, from: number, to: number): Promise<boolean> {
  if (to <= from) return false;
  const db = await rawDb();
  const res = await db.collection(COLLECTION).updateOne({ _id: importId as never, lastBatch: from }, { $set: { lastBatch: to } });
  return res.modifiedCount === 1;
}

/** Imports whose batches may still be missing here (boot + app-channel reconnect catch-up). */
export async function listUnfinishedImportJobs(): Promise<ImportJob[]> {
  const db = await rawDb();
  const docs = await db.collection(COLLECTION).find({ status: { $nin: [...FINAL_IMPORT_STATUSES] } }).toArray();
  return docs.map((d) => toJob(d as Record<string, unknown>)!);
}

export async function deleteImportJob(importId: string): Promise<void> {
  const db = await rawDb();
  await db.collection(COLLECTION).deleteOne({ _id: importId as never });
}

/** Drops entries persons-api no longer keeps (older than its 30-day retention). Returns how many. */
export async function pruneImportJobs(now = Date.now()): Promise<number> {
  const db = await rawDb();
  const docs = await db.collection(COLLECTION).find({}, { projection: { _id: 1 } }).toArray();
  const stale = docs.map((d) => String(d._id)).filter((id) => {
    if (!/^[0-9a-f]{24}$/i.test(id)) return false;
    return now - parseInt(id.slice(0, 8), 16) * 1000 > RETENTION_MS;
  });
  if (stale.length === 0) return 0;
  const res = await db.collection(COLLECTION).deleteMany({ _id: { $in: stale as never[] } });
  return res.deletedCount;
}

export async function ensureImportJobIndexes(): Promise<void> {
  const db = await rawDb();
  await db.collection(COLLECTION).createIndex({ status: 1 });
}

/** tests only */
export async function clearImportJobs(): Promise<void> {
  const db = await rawDb();
  await db.collection(COLLECTION).deleteMany({});
}
