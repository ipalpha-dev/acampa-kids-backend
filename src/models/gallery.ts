import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db";
import { config } from "../config";
import type { GalleryPhoto } from "../types";

/**
 * The camp's PHOTO ALBUM. Each photo is one document here plus one document
 * in `files` (the full-size image). A small thumbnail is a plain file under
 * `FILES_DIR` (named `thumb-<photo id>`) so the grid page loads fast without
 * a second file; `GET /api/gallery/:id/thumb` serves it with no auth (the
 * id is unguessable, like a files id).
 */
const COLLECTION = "gallery";

/** thumbnails share the files volume: <FILES_DIR>/thumb-<photo id> */
function thumbPath(id: string): string {
  return join(config.filesDir, `thumb-${id}`);
}

export interface GalleryPhotoThumb {
  photo: GalleryPhoto;
  thumb: Uint8Array;
  thumbType: string;
}

export interface GalleryFaceEmbedding {
  photoId: string;
  embedding: number[];
  detScore: number;
  model: string;
}

function toPhoto(doc: Record<string, unknown> | null): GalleryPhoto | null {
  if (!doc) return null;
  return {
    _id: doc._id as string,
    fileId: doc.fileId as string,
    // photos uploaded before ordering existed fall back to their upload time
    order: typeof doc.order === "number" ? doc.order : new Date((doc.createdAt as Date) ?? 0).getTime(),
    caption: typeof doc.caption === "string" ? doc.caption : "",
    eventId: (doc.eventId as string | null) ?? null,
    byPersonId: (doc.byPersonId as string) ?? "",
    createdAt: (doc.createdAt as Date) ?? new Date(),
    updatedAt: (doc.updatedAt as Date) ?? new Date(),
  };
}

export interface GalleryPhotoData {
  fileId: string;
  thumb: Uint8Array;
  thumbType: string;
  caption: string;
  eventId: string | null;
  byPersonId: string;
}

export async function insertGalleryPhoto(data: GalleryPhotoData): Promise<GalleryPhoto> {
  const db = await getDb();
  const _id = randomBytes(24).toString("hex");
  const now = new Date();
  await writeFile(thumbPath(_id), data.thumb);
  const doc = {
    _id,
    fileId: data.fileId,
    // newest first by default; a manual arrangement overwrites this
    order: now.getTime(),
    thumbType: data.thumbType,
    caption: data.caption,
    eventId: data.eventId,
    byPersonId: data.byPersonId,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(COLLECTION).insertOne(doc as never);
  return toPhoto(doc)!;
}

/** Every photo, newest first — or in the order the photographer arranged them. */
export async function listGalleryPhotos(): Promise<GalleryPhoto[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find({}, { projection: { thumb: 0 } }).sort({ order: -1, createdAt: -1 }).toArray();
  return docs.map((d) => toPhoto(d as Record<string, unknown>)!);
}

/**
 * Rearranges photos: `ids` is one section in its new order (first = shown first).
 * The photos keep their own pool of `order` values, just redistributed, so the
 * section moves as a block and never collides with the rest of the album.
 */
export async function reorderGalleryPhotos(ids: string[]): Promise<number> {
  const clean = validGalleryIds(ids);
  if (clean.length < 2) return 0;
  const db = await getDb();
  const docs = (await db.collection(COLLECTION).find({ _id: { $in: clean as never[] } }, { projection: { order: 1, createdAt: 1 } }).toArray()) as Record<string, unknown>[];
  if (docs.length < 2) return 0;
  // the values these photos already occupy, biggest first (= shown first)
  const pool = docs
    .map((d) => (typeof d.order === "number" ? d.order : new Date((d.createdAt as Date) ?? 0).getTime()))
    .sort((a, b) => b - a);
  const present = new Set(docs.map((d) => d._id as string));
  // ids the caller sent that no longer exist are skipped, keeping pool aligned
  const ordered = clean.filter((id) => present.has(id));
  const now = new Date();
  await Promise.all(ordered.map((id, i) => db.collection(COLLECTION).updateOne({ _id: id as never }, { $set: { order: pool[i], updatedAt: now } })));
  return ordered.length;
}

export async function listGalleryFaceEmbeddings(): Promise<GalleryFaceEmbedding[]> {
  const db = await getDb();
  const docs = (await db.collection(COLLECTION).find(
    { "faces.0": { $exists: true } },
    { projection: { faces: 1, faceModel: 1 } },
  ).toArray()) as Record<string, unknown>[];
  const out: GalleryFaceEmbedding[] = [];
  for (const doc of docs) {
    const faces = Array.isArray(doc.faces) ? doc.faces as Record<string, unknown>[] : [];
    for (const face of faces) {
      if (!Array.isArray(face.embedding)) continue;
      out.push({
        photoId: doc._id as string,
        embedding: face.embedding as number[],
        detScore: typeof face.detScore === "number" ? face.detScore : 0,
        model: typeof doc.faceModel === "string" ? doc.faceModel : "unknown",
      });
    }
  }
  return out;
}

export async function saveGalleryPhotoFaces(id: string, input: { embeddings: { embedding: number[]; detScore: number }[]; model: string }): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateOne(
    { _id: id as never },
    { $set: { faces: input.embeddings, faceModel: input.model, facesIndexedAt: new Date() } },
  );
  return res.matchedCount === 1;
}

export async function findGalleryPhoto(id: string): Promise<GalleryPhoto | null> {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  const db = await getDb();
  return toPhoto((await db.collection(COLLECTION).findOne({ _id: id as never }, { projection: { thumb: 0 } })) as Record<string, unknown> | null);
}

/** Photo WITH the thumbnail bytes (only the thumb route needs this). */
export async function findGalleryPhotoThumb(id: string): Promise<GalleryPhotoThumb | null> {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  const db = await getDb();
  const doc = (await db.collection(COLLECTION).findOne({ _id: id as never })) as Record<string, unknown> | null;
  if (!doc) return null;
  const thumb = await readFile(thumbPath(id)).catch(() => null);
  return { photo: toPhoto(doc)!, thumb: thumb ? new Uint8Array(thumb) : new Uint8Array(), thumbType: (doc.thumbType as string) ?? "image/jpeg" };
}

export interface GalleryPhotoPatch {
  caption?: string;
  eventId?: string | null;
}

export async function updateGalleryPhoto(id: string, patch: GalleryPhotoPatch): Promise<GalleryPhoto | null> {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.caption !== undefined) set.caption = patch.caption;
  if (patch.eventId !== undefined) set.eventId = patch.eventId;
  const res = await db.collection(COLLECTION).findOneAndUpdate({ _id: id as never }, { $set: set }, { returnDocument: "after", projection: { thumb: 0 } });
  return toPhoto(res as Record<string, unknown> | null);
}

const ID_RE = /^[a-f0-9]{16,64}$/;

/** Keeps only well-formed ids (the bulk routes take a list straight from the client). */
export function validGalleryIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && ID_RE.test(id)))];
}

/** Bulk edit: moves photos to an event / publishes them in ONE round-trip. */
export async function updateGalleryPhotos(ids: string[], patch: GalleryPhotoPatch): Promise<number> {
  const clean = validGalleryIds(ids);
  if (clean.length === 0) return 0;
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.caption !== undefined) set.caption = patch.caption;
  if (patch.eventId !== undefined) set.eventId = patch.eventId;
  const res = await db.collection(COLLECTION).updateMany({ _id: { $in: clean as never[] } }, { $set: set });
  return res.modifiedCount;
}

/**
 * Bulk delete. Returns the deleted documents so the route can drop their
 * full-size files too (the thumbnails are unlinked here).
 */
export async function deleteGalleryPhotos(ids: string[]): Promise<GalleryPhoto[]> {
  const clean = validGalleryIds(ids);
  if (clean.length === 0) return [];
  const db = await getDb();
  const docs = (await db.collection(COLLECTION).find({ _id: { $in: clean as never[] } }, { projection: { thumb: 0 } }).toArray()) as Record<string, unknown>[];
  if (docs.length === 0) return [];
  const found = docs.map((d) => toPhoto(d)!);
  await db.collection(COLLECTION).deleteMany({ _id: { $in: found.map((p) => p._id) as never[] } });
  await Promise.all(found.map((p) => unlink(thumbPath(p._id)).catch(() => {})));
  return found;
}

export async function deleteGalleryPhoto(id: string): Promise<GalleryPhoto | null> {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  const db = await getDb();
  const res = await db.collection(COLLECTION).findOneAndDelete({ _id: id as never }, { projection: { thumb: 0 } });
  await unlink(thumbPath(id)).catch(() => {}); // the thumbnail may already be gone
  return toPhoto(res as Record<string, unknown> | null);
}

/** An event left the programme → its photos become general (never orphaned ids). */
export async function detachGalleryFromEvent(eventId: string): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ eventId }, { $set: { eventId: null, updatedAt: new Date() } });
  return res.modifiedCount;
}

export async function listUnindexedGalleryPhotos(limit = 25): Promise<GalleryPhoto[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find(
    { facesIndexedAt: { $exists: false } },
    { projection: { thumb: 0 } },
  ).sort({ createdAt: 1 }).limit(limit).toArray();
  return docs.map((d) => toPhoto(d as Record<string, unknown>)!);
}

export async function ensureGalleryIndexes(): Promise<void> {
  await mkdir(config.filesDir, { recursive: true });
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ createdAt: -1 });
  await db.collection(COLLECTION).createIndex({ eventId: 1 }, { sparse: true });
  await db.collection(COLLECTION).createIndex({ order: -1 });
  await db.collection(COLLECTION).createIndex({ facesIndexedAt: 1 }, { sparse: true });
  // publishing moved to settings.galleryPublished: drop the per-photo flags
  await db.collection(COLLECTION).updateMany({ $or: [{ published: { $exists: true } }, { publishedAt: { $exists: true } }] }, { $unset: { published: "", publishedAt: "" } });
  // photos from before ordering existed: seed `order` from the upload time once
  const legacy = (await db.collection(COLLECTION).find({ order: { $exists: false } }, { projection: { createdAt: 1 } }).toArray()) as Record<string, unknown>[];
  for (const doc of legacy) {
    await db.collection(COLLECTION).updateOne({ _id: doc._id as never }, { $set: { order: new Date((doc.createdAt as Date) ?? 0).getTime() } });
  }
}
