import { ObjectId } from "mongodb";
import { getDb } from "../db";
import { BUS_COLORS, type Transport, type TransportKind } from "../types";
import { ensureIndex } from "../services/indexes";

const COLLECTION = "transports";

function toTransport(doc: Record<string, unknown> | null): Transport | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    draft: doc.draft === true,
    importId: (doc.importId as string) ?? undefined,
    kind: (doc.kind as TransportKind) ?? "bus",
    name: (doc.name as string) ?? undefined,
    color: (doc.color as string) ?? undefined,
    number: (doc.number as string) ?? undefined,
    capacity: (doc.capacity as number) ?? undefined,
    order: (doc.order as number) ?? 0,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export async function listTransports(includeDraft = false): Promise<Transport[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find(includeDraft ? {} : { draft: { $ne: true } }).sort({ order: 1 }).toArray();
  return docs.map((d) => toTransport(d as Record<string, unknown>)!);
}

export async function findTransportById(id: string): Promise<Transport | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toTransport(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function insertTransport(
  data: Omit<Transport, "_id" | "createdAt" | "updatedAt">,
): Promise<Transport> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db
    .collection(COLLECTION)
    .insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateTransport(
  id: string,
  patch: Partial<Omit<Transport, "_id" | "createdAt" | "updatedAt">>,
): Promise<Transport | null> {
  const db = await getDb();
  // undefined fields (a bus becoming a car) must be $unset, not $set
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const unset: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) unset[k] = "";
    else set[k] = v;
  }
  const update: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, update, { returnDocument: "after" });
  return toTransport(res as Record<string, unknown> | null);
}

export async function deleteTransport(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

export async function nextTransportOrder(): Promise<number> {
  const db = await getDb();
  const last = await db.collection(COLLECTION).find().sort({ order: -1 }).limit(1).toArray();
  return last.length ? ((last[0].order as number) ?? 0) + 1 : 0;
}

export async function ensureTransportIndexes(): Promise<void> {
  const db = await getDb();
  await ensureIndex(db.collection(COLLECTION), { order: 1 });
}

