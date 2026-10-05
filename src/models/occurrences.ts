import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { CoreRole, Occurrence, OccurrenceGroup } from "../types";

const COLLECTION = "occurrences";
const GROUPS = new Set<OccurrenceGroup>(["admin", "organizer", "medical"]);

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function toOccurrence(doc: Record<string, unknown> | null): Occurrence | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    campers: ids(doc.campers),
    staff: ids(doc.staff),
    description: (doc.description as string) ?? "",
    createdByPersonId: (doc.createdByPersonId as string) ?? "",
    createdByRole: (doc.createdByRole as CoreRole) ?? "coordenacao",
    createdByGroup: GROUPS.has(doc.createdByGroup as OccurrenceGroup) ? (doc.createdByGroup as OccurrenceGroup) : "admin",
    createdAt: doc.createdAt as Date,
  };
}

export type OccurrenceData = Omit<Occurrence, "_id" | "createdAt">;

/** The coordenação reads every group; the medical team / organizers only the records their group created. */
export async function occurrencesForGroup(list: Occurrence[], group: OccurrenceGroup): Promise<Occurrence[]> {
  return group === "admin" ? list : list.filter((o) => o.createdByGroup === group);
}

export async function listOccurrences(): Promise<Occurrence[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find().sort({ createdAt: -1 }).toArray();
  return docs.map((doc) => toOccurrence(doc as Record<string, unknown>)!);
}

export async function insertOccurrence(data: OccurrenceData): Promise<Occurrence> {
  const db = await getDb();
  const createdAt = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt });
  return { ...data, _id: insertedId.toString(), createdAt };
}

export async function ensureOccurrenceIndexes(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTION).createIndex({ createdAt: -1 }),
    db.collection(COLLECTION).createIndex({ createdByGroup: 1, createdAt: -1 }),
    db.collection(COLLECTION).createIndex({ campers: 1, createdAt: -1 }),
    db.collection(COLLECTION).createIndex({ staff: 1, createdAt: -1 }),
  ]);
}
