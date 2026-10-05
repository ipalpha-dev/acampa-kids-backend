import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { InstructionDoc, DocAudience } from "../types";
import { DOC_AUDIENCES } from "../types";
import { ensureIndex } from "../services/indexes";

const COLLECTION = "instructions";

function toDoc(doc: Record<string, unknown> | null): InstructionDoc | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    title: doc.title as string,
    emoji: (doc.emoji as string) ?? "📖",
    audience: DOC_AUDIENCES.includes(doc.audience as DocAudience) ? (doc.audience as DocAudience) : "all",
    content: (doc.content as string) ?? "",
    order: (doc.order as number) ?? 0,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export type InstructionData = Omit<InstructionDoc, "_id" | "createdAt" | "updatedAt">;

export async function listInstructions(): Promise<InstructionDoc[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find().sort({ order: 1, createdAt: 1 }).toArray();
  return docs.map((d) => toDoc(d as Record<string, unknown>)!);
}

export async function findInstructionById(id: string): Promise<InstructionDoc | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toDoc(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function nextInstructionOrder(): Promise<number> {
  const db = await getDb();
  const last = await db.collection(COLLECTION).find().sort({ order: -1 }).limit(1).toArray();
  return last.length ? ((last[0].order as number) ?? 0) + 1 : 0;
}

export async function insertInstruction(data: InstructionData): Promise<InstructionDoc> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateInstruction(id: string, patch: Partial<InstructionData>): Promise<InstructionDoc | null> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toDoc(res as Record<string, unknown> | null);
}

export async function deleteInstruction(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

export async function ensureInstructionIndexes(): Promise<void> {
  const db = await getDb();
  await ensureIndex(db.collection(COLLECTION), { order: 1 });
}
