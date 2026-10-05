import { ObjectId } from "mongodb";
import { getDb } from "../db";
import { seal, unseal } from "../services/session";
import { aiReviewRetryPendingFilter } from "./aiReviewRetry";
import type { CamperImportStatus, CamperImportDictionaryEntry, CamperImportReviewItem, StaffImportReviewItem } from "../types";

const IMPORTS = "camperImports";
const DICTIONARY = "camperImportDictionary";

export interface CamperImportColumn {
  source: string;
  target: string | null;
  confidence: number;
  samples: string[];
}

export interface CamperImportCreatedItem {
  kind: "bedroom" | "transportation" | "team" | "categoryOption" | "staff";
  id: string;
  label: string;
  draft: boolean;
}

export interface CamperImportRecord {
  _id: string;
  fileName: string;
  subject: "camper" | "staff";
  fileType: string;
  /** SHA-256 of the browser-owned original file, used to guard the final apply. */
  fileHash: string;
  status: CamperImportStatus;
  dryRun: boolean;
  columns: CamperImportColumn[];
  rows: Record<string, string>[];
  dictionaries: CamperImportDictionaryEntry[];
  reviews: (CamperImportReviewItem | StaffImportReviewItem)[];
  preview: Record<string, unknown>[];
  skipped: Record<string, unknown>[];
  createdItems: CamperImportCreatedItem[];
  dateFunction: string;
  startedAt: Date;
  reviewStartedAt: Date | null;
  finishedAt: Date | null;
  finishedSmsSentAt: Date | null;
  errorSmsSentAt: Date | null;
  notificationCheckedAt: Date | null;
  createdByPersonId: string;
  error: string;
  /** when the AI health pass paused for a new sign-in (status `needsSignIn`), else null */
  pausedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `pausedAt` is set only by pause / resume below. */
export type CamperImportData = Omit<CamperImportRecord, "_id" | "createdAt" | "updatedAt" | "pausedAt">;

/**
 * The importer's persons-api role token for the background AI health pass
 * (decision 50): sealed with AES-256-GCM (`SESSION_TOKEN_KEY`, the session
 * scheme) in the import's `jobToken` field, opened only by the worker to write
 * health to persons-api, and deleted when the job ends (all reviews terminal,
 * the apply failed) or the token is refused. Never serialized, never logged.
 */
export interface ImportJobToken {
  token: string;
  /** epoch ms — the role grant's expiry */
  expiresAt: number;
}

function toImport(doc: Record<string, unknown> | null): CamperImportRecord | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    fileName: (doc.fileName as string) ?? "planilha",
    subject: doc.subject === "staff" ? "staff" : "camper",
    fileType: (doc.fileType as string) ?? "",
    fileHash: (doc.fileHash as string) ?? "",
    status: (doc.status as CamperImportStatus) ?? "analyzing",
    dryRun: doc.dryRun !== false,
    columns: (doc.columns as CamperImportColumn[]) ?? [],
    rows: (doc.rows as Record<string, string>[]) ?? [],
    dictionaries: (doc.dictionaries as CamperImportDictionaryEntry[]) ?? [],
    reviews: (doc.reviews as (CamperImportReviewItem | StaffImportReviewItem)[]) ?? [],
    preview: (doc.preview as Record<string, unknown>[]) ?? [],
    skipped: (doc.skipped as Record<string, unknown>[]) ?? [],
    createdItems: (doc.createdItems as CamperImportCreatedItem[]) ?? [],
    dateFunction: (doc.dateFunction as string) ?? "",
    startedAt: (doc.startedAt as Date) ?? new Date(),
    reviewStartedAt: (doc.reviewStartedAt as Date) ?? null,
    finishedAt: (doc.finishedAt as Date) ?? null,
    finishedSmsSentAt: (doc.finishedSmsSentAt as Date) ?? null,
    errorSmsSentAt: (doc.errorSmsSentAt as Date) ?? null,
    notificationCheckedAt: (doc.notificationCheckedAt as Date) ?? null,
    createdByPersonId: (doc.createdByPersonId as string) ?? "",
    error: (doc.error as string) ?? "",
    pausedAt: (doc.pausedAt as Date) ?? null,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export async function insertCamperImport(data: CamperImportData): Promise<CamperImportRecord> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(IMPORTS).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), pausedAt: null, createdAt: now, updatedAt: now };
}

export async function findCamperImport(id: string): Promise<CamperImportRecord | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toImport(await db.collection(IMPORTS).findOne({ _id: new ObjectId(id) }));
}

export async function updateCamperImport(id: string, patch: Partial<CamperImportData>): Promise<CamperImportRecord | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const doc = await db.collection(IMPORTS).findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  return toImport(doc as Record<string, unknown> | null);
}

/** Atomically prevents two Apply requests from inserting the same spreadsheet twice. */
export async function claimCamperImport(id: string): Promise<CamperImportRecord | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const now = new Date();
  const doc = await db.collection(IMPORTS).findOneAndUpdate(
    { _id: new ObjectId(id), status: { $in: ["ready", "review"] } },
    { $set: { status: "importing", dryRun: false, reviewStartedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  return toImport(doc as Record<string, unknown> | null);
}

/** Imports whose campers are all terminal but whose notifications still need an audit. */
export async function listImportsPendingNotification(): Promise<CamperImportRecord[]> {
  const db = await getDb();
  const docs = await db.collection(IMPORTS).find({
    status: "completed",
    notificationCheckedAt: null,
  }).sort({ reviewStartedAt: 1 }).limit(200).toArray();
  return docs.map((d) => toImport(d as Record<string, unknown>)!).filter(Boolean);
}

export async function upsertImportDictionary(entries: CamperImportDictionaryEntry[], importId: string): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  const now = new Date();
  await db.collection(DICTIONARY).bulkWrite(
    entries.map((entry) => ({
      updateOne: {
        filter: { field: entry.field, normalized: entry.normalized },
        update: {
          $set: { ...entry, importId, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    })),
  );
}

export async function listImportDictionary(): Promise<CamperImportDictionaryEntry[]> {
  const db = await getDb();
  const docs = await db.collection(DICTIONARY).find().sort({ field: 1, normalized: 1 }).toArray();
  return docs.map((d) => ({
    field: (d.field as string) ?? "",
    raw: (d.raw as string) ?? "",
    normalized: (d.normalized as string) ?? "",
    value: d.value ?? null,
    label: (d.label as string) ?? "",
    draft: d.draft === true,
    kind: (d.kind as CamperImportDictionaryEntry["kind"]) ?? "text",
  }));
}

export async function markImportDictionaryPublished(importId: string): Promise<void> {
  const db = await getDb();
  await db.collection(DICTIONARY).updateMany({ importId }, { $set: { draft: false, updatedAt: new Date() } });
}

/** Stores (replaces) the importer's sealed token for the job. */
export async function storeImportJobToken(id: string, job: ImportJobToken): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const db = await getDb();
  await db.collection(IMPORTS).updateOne({ _id: new ObjectId(id) }, { $set: { jobToken: seal(JSON.stringify(job)), updatedAt: new Date() } });
}

/** The job's token, or null (none / unreadable / expired at `now`). */
export async function openImportJobToken(id: string, now = Date.now()): Promise<ImportJobToken | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const doc = await db.collection(IMPORTS).findOne({ _id: new ObjectId(id) }, { projection: { jobToken: 1 } });
  const sealed = typeof doc?.jobToken === "string" ? doc.jobToken : "";
  if (!sealed) return null;
  try {
    const job = JSON.parse(unseal(sealed)) as ImportJobToken;
    return typeof job.token === "string" && job.token && typeof job.expiresAt === "number" && job.expiresAt > now ? job : null;
  } catch {
    return null;
  }
}

/** Deletes the job's token (the job ended). */
export async function dropImportJobToken(id: string): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const db = await getDb();
  await db.collection(IMPORTS).updateOne({ _id: new ObjectId(id), jobToken: { $exists: true } }, { $unset: { jobToken: "" }, $set: { updatedAt: new Date() } });
}

/**
 * Ends the job when nothing of the import is left for the worker (no row
 * pending / running / structured / waiting for a retry): its token goes.
 */
export async function endImportJobIfIdle(id: string): Promise<boolean> {
  const db = await getDb();
  const open = await db.collection("participants").countDocuments({
    importId: id,
    $or: [{ aiReviewStatus: { $in: ["pending", "processing", "structured"] } }, aiReviewRetryPendingFilter()],
  });
  if (open > 0) return false;
  await dropImportJobToken(id);
  return true;
}

/**
 * Pauses the AI health pass of an import whose token was refused / expired:
 * status `needsSignIn`, the dead token deleted. True when this call paused it.
 */
export async function pauseImportForSignIn(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const now = new Date();
  const res = await db.collection(IMPORTS).updateOne(
    { _id: new ObjectId(id), status: { $in: ["importing", "completed"] } },
    { $set: { status: "needsSignIn", pausedAt: now, updatedAt: now }, $unset: { jobToken: "" } },
  );
  return res.modifiedCount === 1;
}

/** Resumes a paused import with the importer's fresh token. Null when it was not paused. */
export async function resumeImportWithToken(id: string, job: ImportJobToken): Promise<CamperImportRecord | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const doc = await db.collection(IMPORTS).findOneAndUpdate(
    { _id: new ObjectId(id), status: "needsSignIn" },
    { $set: { status: "completed", pausedAt: null, jobToken: seal(JSON.stringify(job)), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  return toImport(doc as Record<string, unknown> | null);
}

/** Ids of imports waiting for a new sign-in (the worker leaves their rows alone). */
export async function listPausedImportIds(): Promise<string[]> {
  const db = await getDb();
  const docs = await db.collection(IMPORTS).find({ status: "needsSignIn" }, { projection: { _id: 1 } }).limit(500).toArray();
  return docs.map((d) => String(d._id));
}

/** The paused imports this person started (newest first) — the import screen offers "resume" for them. */
export async function listImportsNeedingSignIn(personId: string): Promise<CamperImportRecord[]> {
  const db = await getDb();
  const docs = await db.collection(IMPORTS).find({ status: "needsSignIn", createdByPersonId: personId }).sort({ pausedAt: -1 }).limit(50).toArray();
  return docs.map((d) => toImport(d as Record<string, unknown>)!).filter(Boolean);
}

export async function ensureCamperImportIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(IMPORTS).createIndex({ createdAt: -1 });
  await db.collection(IMPORTS).createIndex({ status: 1, startedAt: 1 });
  await db.collection(DICTIONARY).createIndex({ field: 1, normalized: 1 }, { unique: true });
  await db.collection(DICTIONARY).createIndex({ importId: 1, draft: 1 });
}
