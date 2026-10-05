import { ObjectId } from "mongodb";
import { rawDb } from "../db";
import { refreshActiveCamp } from "../services/campContext";

const COLLECTION = "camps";

export interface Camp {
  _id: string;
  label: string;
  year: number;
  active: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  /** person id of whoever created the camp */
  createdByPersonId: string | null;
  /** the projects-api edition of this camp (resolved by year, kept once known) */
  editionId: string | null;
}

function toCamp(doc: Record<string, unknown> | null): Camp | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    label: doc.label as string,
    year: doc.year as number,
    active: doc.active === true,
    archivedAt: (doc.archivedAt as Date) ?? null,
    createdAt: doc.createdAt as Date,
    createdByPersonId: (doc.createdByPersonId as string) ?? null,
    editionId: typeof doc.editionId === "string" ? doc.editionId : null,
  };
}

export async function listCamps(): Promise<Camp[]> {
  const db = await rawDb();
  const docs = await db.collection(COLLECTION).find().sort({ year: -1 }).toArray();
  return docs.map((d) => toCamp(d as Record<string, unknown>)!);
}

export async function findCamp(id: string): Promise<Camp | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await rawDb();
  return toCamp(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function getActiveCamp(): Promise<Camp | null> {
  const db = await rawDb();
  return toCamp(await db.collection(COLLECTION).findOne({ active: true }));
}

export async function createCamp(data: { label: string; year: number; createdByPersonId: string | null }): Promise<Camp> {
  const db = await rawDb();
  const now = new Date();
  const doc = { label: data.label, year: data.year, active: false, archivedAt: null, createdAt: now, createdByPersonId: data.createdByPersonId, editionId: null };
  const { insertedId } = await db.collection(COLLECTION).insertOne(doc);
  return toCamp({ ...doc, _id: insertedId })!;
}

/** Remembers the projects-api edition of a camp (a year change forgets it). */
export async function setCampEditionId(id: string, editionId: string | null): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const db = await rawDb();
  await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: { editionId } });
}

/** Makes `id` the active camp: the previous active one is archived, then the shared cache is refreshed. */
export async function activateCamp(id: string): Promise<Camp> {
  if (!ObjectId.isValid(id)) throw new Error("activateCamp: invalid id");
  const db = await rawDb();
  const now = new Date();
  await db.collection(COLLECTION).updateMany({ active: true, _id: { $ne: new ObjectId(id) } }, { $set: { active: false, archivedAt: now } });
  await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: { active: true, archivedAt: null } });
  return refreshActiveCamp();
}

export async function updateCamp(id: string, patch: { label?: string; year?: number; archived?: boolean }): Promise<Camp | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await rawDb();
  const now = new Date();
  const set: Record<string, unknown> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.year !== undefined) {
    set.year = patch.year;
    set.editionId = null; // another year = another edition, resolved again on use
  }
  if (patch.archived === true) {
    set.active = false;
    set.archivedAt = now;
  } else if (patch.archived === false) {
    set.archivedAt = null;
  }
  const res = await db.collection(COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: set }, { returnDocument: "after" });
  return toCamp(res as Record<string, unknown> | null);
}

/** Unique-active guard: at most one `{active:true}` document at a time. Best-effort — logs and continues if the server can't create a partial index. */
export async function ensureCampsCollection(): Promise<void> {
  const db = await rawDb();
  try {
    await db.collection(COLLECTION).createIndex({ active: 1 }, { unique: true, partialFilterExpression: { active: true } });
  } catch (err) {
    console.error("camps: could not create the unique-active index", err);
  }
}

export interface CampDeleteOtp {
  codeHash: string;
  requestedByPersonId: string;
  expiresAt: Date;
  attempts: number;
}

/** Stores (or overwrites) the pending delete confirmation code on the camp doc. */
export async function setCampDeleteOtp(id: string, otp: CampDeleteOtp): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const db = await rawDb();
  await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: { deleteOtp: otp } });
}

export async function getCampDeleteOtp(id: string): Promise<CampDeleteOtp | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await rawDb();
  const doc = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
  return (doc?.deleteOtp as CampDeleteOtp | undefined) ?? null;
}

export async function clearCampDeleteOtp(id: string): Promise<void> {
  if (!ObjectId.isValid(id)) return;
  const db = await rawDb();
  await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $unset: { deleteOtp: "" } });
}

/** Counts, per SCOPED collection, computed on the RAW collections (camp-filtered explicitly — `camps` itself is unscoped). */
export async function campCounts(id: string): Promise<{ campers: number; staff: number; photos: number }> {
  const db = await rawDb();
  const [campers, staff, photos] = await Promise.all([
    db.collection("participants").countDocuments({ campId: id, kind: "camper" }),
    db.collection("participants").countDocuments({ campId: id, kind: "team" }),
    db.collection("gallery").countDocuments({ campId: id }),
  ]);
  return { campers, staff, photos };
}
