import { getDb, rawDb } from "../db";
import type { HealthInfo } from "../types";

/**
 * `healthQueue` — the ONLY place health ever touches Acampa's Mongo, and only
 * in transit: the background import worker turns a participant's free-text
 * observations into a structured health patch, but it holds no person token,
 * so the patch waits here until a coordenação session writes it to
 * persons-api (`POST /api/people/health-queue/flush`, called by the import
 * screen after each `ai-review-done` event). Written items are deleted; a TTL
 * index drops anything left behind after 7 days. Scoped per camp.
 */
const COLLECTION = "healthQueue";
const TTL_SECONDS = 7 * 24 * 3600;

export interface HealthQueueItem {
  _id: string;
  personId: string;
  kind: "camper" | "team";
  importId: string | null;
  /** the fields to write (merged over the person's current health) */
  patch: Partial<HealthInfo>;
  createdAt: Date;
}

export async function enqueueHealth(item: Omit<HealthQueueItem, "_id" | "createdAt">): Promise<void> {
  if (Object.keys(item.patch).length === 0) return;
  const db = await getDb();
  // one pending patch per person: a newer one replaces the older
  await db.collection(COLLECTION).updateOne({ personId: item.personId }, { $set: { ...item, createdAt: new Date() } }, { upsert: true });
}

export async function listHealthQueue(limit = 200): Promise<HealthQueueItem[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find({}).sort({ createdAt: 1 }).limit(limit).toArray();
  return docs.map((d) => ({ _id: String(d._id), personId: d.personId as string, kind: d.kind as HealthQueueItem["kind"], importId: (d.importId as string) ?? null, patch: (d.patch as Partial<HealthInfo>) ?? {}, createdAt: d.createdAt as Date }));
}

export async function countHealthQueue(): Promise<number> {
  const db = await getDb();
  return db.collection(COLLECTION).countDocuments({});
}

export async function dropHealthQueueItem(personId: string): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).deleteOne({ personId });
}

export async function ensureHealthQueueIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ personId: 1 }, { unique: true });
  // a TTL index must be single-field: created on the raw (unscoped) collection
  await (await rawDb()).collection(COLLECTION).createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS, name: "ttl" });
}
