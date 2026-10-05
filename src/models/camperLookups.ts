import { getDb } from "../db";
import { ensureIndex } from "../services/indexes";

const COLLECTION = "camperLookups";

/** One emergency QR scan of a kid by a team member (GET /api/campers/lookup/:id). */
export interface CamperLookup {
  _id: string;
  at: Date;
  /** the kid (person id) */
  camperId: string;
  /** who scanned (person id) */
  byStaffId: string;
  /** true when the kid was already in the scanner's normal scope */
  belonged: boolean;
}

export async function insertCamperLookup(data: Omit<CamperLookup, "_id">): Promise<CamperLookup> {
  const db = await getDb();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data });
  return { ...data, _id: insertedId.toString() };
}

export async function ensureCamperLookupIndexes(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    ensureIndex(db.collection(COLLECTION), { at: -1 }),
    ensureIndex(db.collection(COLLECTION), { byStaffId: 1, belonged: 1, camperId: 1 }),
    ensureIndex(db.collection(COLLECTION), { byStaffId: 1, at: -1 }),
  ]);
}
