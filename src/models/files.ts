import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { getDb } from "../db";
import type { StoredFile } from "../types";
import { ensureIndex } from "../services/indexes";

/**
 * Images uploaded through the WYSIWYG editor AND the photo album's full-size
 * pictures. The BYTES live on disk, under `FILES_DIR` (a mounted volume in
 * production — plain files named by their unguessable id); MongoDB keeps only
 * the metadata. Ids are 24 random bytes in hex — unguessable — which is what
 * lets `GET /api/files/:id` be public (an <img> tag cannot send an
 * Authorization header).
 */
const COLLECTION = "files";

const DIR = config.filesDir;

async function ensureDir(): Promise<void> {
  await mkdir(DIR, { recursive: true });
}

function pathOf(id: string): string {
  return join(DIR, id);
}

export async function insertFile(input: { name: string; type: string; data: Uint8Array; byPersonId: string }): Promise<StoredFile> {
  await ensureDir();
  const db = await getDb();
  const _id = randomBytes(24).toString("hex");
  await writeFile(pathOf(_id), input.data);
  const meta = {
    _id,
    name: input.name,
    type: input.type,
    size: input.data.byteLength,
    byPersonId: input.byPersonId,
    createdAt: new Date(),
  };
  await db.collection(COLLECTION).insertOne(meta as never);
  return meta;
}

export async function findFileWithData(id: string): Promise<(StoredFile & { data: Uint8Array }) | null> {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  const db = await getDb();
  const doc = (await db.collection(COLLECTION).findOne({ _id: id as never })) as Record<string, unknown> | null;
  if (!doc) return null;
  // the bytes live on disk only
  const disk = await readFile(pathOf(id)).catch(() => null);
  if (!disk) return null;
  return { _id: id, name: doc.name as string, type: doc.type as string, size: doc.size as number, byPersonId: doc.byPersonId as string, createdAt: doc.createdAt as Date, data: new Uint8Array(disk) };
}

/** Id of the most recent upload with this exact name (used by the seeds to avoid re-uploading their assets). */
export async function findFileIdByName(name: string): Promise<string | null> {
  const db = await getDb();
  const doc = await db.collection(COLLECTION).findOne({ name }, { projection: { _id: 1 }, sort: { createdAt: -1 } });
  return doc ? (doc._id as unknown as string) : null;
}

export async function deleteFile(id: string): Promise<boolean> {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: id as never });
  await unlink(pathOf(id)).catch(() => {}); // the disk copy may already be gone
  return res.deletedCount === 1;
}

export async function ensureFileIndexes(): Promise<void> {
  await ensureDir();
  const db = await getDb();
  await ensureIndex(db.collection(COLLECTION), { createdAt: 1 });
}
