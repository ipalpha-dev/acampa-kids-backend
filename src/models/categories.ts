import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { Category, CategoryAudience, CategoryOption, CategorySelection } from "../types";
import { ensureIndex } from "../services/indexes";

const COLLECTION = "categories";

function toCategory(doc: Record<string, unknown> | null): Category | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    key: doc.key as string,
    name: doc.name as string,
    emoji: (doc.emoji as string) ?? "🏷️",
    description: (doc.description as string) ?? undefined,
    appliesTo: (doc.appliesTo as CategoryAudience[]) ?? [],
    selection: (doc.selection as CategorySelection) ?? "single",
    options: ((doc.options as CategoryOption[]) ?? []).slice().sort((a, b) => a.order - b.order),
    order: (doc.order as number) ?? 0,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

/** "Quarto / Bedroom" → "quarto-bedroom" */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function newOptionId(): string {
  return new ObjectId().toString();
}

export async function listCategories(filter: { audience?: CategoryAudience } = {}): Promise<Category[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};
  if (filter.audience) query.appliesTo = filter.audience;
  const docs = await db.collection(COLLECTION).find(query).sort({ order: 1, name: 1 }).toArray();
  return docs.map((d) => toCategory(d as Record<string, unknown>)!);
}

export async function findCategoryById(id: string): Promise<Category | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toCategory(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function findCategoryByKey(key: string): Promise<Category | null> {
  const db = await getDb();
  return toCategory(await db.collection(COLLECTION).findOne({ key }));
}

export async function insertCategory(
  data: Omit<Category, "_id" | "createdAt" | "updatedAt">,
): Promise<Category> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db
    .collection(COLLECTION)
    .insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateCategory(
  id: string,
  patch: Partial<Omit<Category, "_id" | "createdAt" | "updatedAt">>,
): Promise<Category | null> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
  return toCategory(res as Record<string, unknown> | null);
}

/** Atomically appends one option; safe when independent import tasks run together. */
export async function appendCategoryOption(id: string, option: CategoryOption): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db.collection<{ _id: ObjectId; options: CategoryOption[]; updatedAt: Date }>(COLLECTION).updateOne(
    { _id: new ObjectId(id), "options.id": { $ne: option.id } },
    { $push: { options: option }, $set: { updatedAt: new Date() } },
  );
  return res.modifiedCount === 1;
}

export async function deleteCategory(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

export async function nextCategoryOrder(): Promise<number> {
  const db = await getDb();
  const last = await db.collection(COLLECTION).find().sort({ order: -1 }).limit(1).toArray();
  return last.length ? ((last[0].order as number) ?? 0) + 1 : 0;
}

export async function ensureCategoryIndexes(): Promise<void> {
  const db = await getDb();
  await ensureIndex(db.collection(COLLECTION), { key: 1 }, { unique: true });
  await ensureIndex(db.collection(COLLECTION), { appliesTo: 1, order: 1 });
}
