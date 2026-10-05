import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { Bedroom, BedroomGroup } from "../types";

const COLLECTION = "bedrooms";

function toBedroom(doc: Record<string, unknown> | null): Bedroom | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    draft: doc.draft === true,
    importId: (doc.importId as string) ?? undefined,
    name: doc.name as string,
    group: doc.group as BedroomGroup,
    bunkBeds: (doc.bunkBeds as number) ?? 0,
    singleBeds: (doc.singleBeds as number) ?? 0,
    notes: (doc.notes as string) ?? "",
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export type BedroomData = Omit<Bedroom, "_id" | "createdAt" | "updatedAt">;

export async function listBedrooms(filter: { group?: BedroomGroup; includeDraft?: boolean } = {}): Promise<Bedroom[]> {
  const db = await getDb();
  const query: Record<string, unknown> = filter.includeDraft ? {} : { draft: { $ne: true } };
  if (filter.group) query.group = filter.group;
  const docs = await db
    .collection(COLLECTION)
    .find(query)
    .collation({ locale: "pt", numericOrdering: true })
    .sort({ group: 1, name: 1 })
    .toArray();
  return docs.map((d) => toBedroom(d as Record<string, unknown>)!);
}

export async function findBedroomById(id: string): Promise<Bedroom | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toBedroom(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function findBedroomByName(name: string): Promise<Bedroom | null> {
  const db = await getDb();
  return toBedroom(await db.collection(COLLECTION).findOne({ name }));
}

export async function insertBedroom(data: BedroomData): Promise<Bedroom> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateBedroom(id: string, patch: Partial<BedroomData>): Promise<Bedroom | null> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
  return toBedroom(res as Record<string, unknown> | null);
}

export async function deleteBedroom(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/** How many staff members are currently assigned to each bedroom. */
export async function countStaffPerBedroom(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .collection("participants")
    .aggregate<{ _id: string; n: number }>([
      { $match: { kind: "team", draft: { $ne: true }, bedroom: { $type: "string" } } },
      { $group: { _id: "$bedroom", n: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

export async function ensureBedroomIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ name: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ group: 1, name: 1 });
}
