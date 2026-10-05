import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { deleteFile, insertFile } from "../models/files";
import { detachGalleryFromEvent, deleteGalleryPhoto, deleteGalleryPhotos, findGalleryPhoto, findGalleryPhotoThumb, insertGalleryPhoto, listGalleryFaceEmbeddings, listGalleryPhotos, listUnindexedGalleryPhotos, reorderGalleryPhotos, updateGalleryPhoto, updateGalleryPhotos, validGalleryIds } from "../models/gallery";
import { getSettings, updateSettings } from "../models/settings";
import { findEventById } from "../models/schedule";
import { resolveScope } from "../services/scope";
import { publish } from "../services/realtime";
import { notifyPhotosPublished } from "../services/notify";
import { config } from "../config";
import { cosineSimilarity, extractFaceEmbeddings, faceRecognitionEnabled } from "../services/faceRecognition";
import { indexGalleryPhotoFaces } from "../services/galleryFaces";
import type { GalleryPhoto } from "../types";

type Env = { Variables: AuthVariables };

/**
 * The camp's photo album ("Fotos" tab).
 *
 *   GET    /api/gallery            (anyone logged in; only PUBLISHED photos
 *                                   unless the viewer may manage them)
 *   POST   /api/gallery            (admin or photographer; multipart
 *                                   file + thumb + caption + eventId)
 *   PUT    /api/gallery/:id        (admin or photographer; caption / event)
 *   DELETE /api/gallery/:id        (admin or photographer)
 *   PUT    /api/gallery/bulk       (admin or photographer; { ids, eventId? }
 *                                   — move a selection to an event)
 *   POST   /api/gallery/bulk-delete (admin or photographer; { ids })
 *   PUT    /api/gallery/reorder    (admin or photographer; { ids } — one
 *                                   section in its new order)
 *   GET    /api/gallery/:id/thumb  (public — the id is unguessable)
 *
 * The photographer uploads, checks the result and then flips the ALBUM switch
 * (settings.galleryPublished) — from that instant every parent and team member
 * sees the photos. There is no per-photo publishing.
 */
const gallery = new Hono<Env>();

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_THUMB_BYTES = 256 * 1024;
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const CAPTION_MAX = 140;
/** a single bulk request never touches more photos than this */
const BULK_MAX = 500;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 | 413 | 415 | 503 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializePhoto(p: GalleryPhoto) {
  return {
    id: p._id,
    url: `/api/files/${p.fileId}`,
    thumbUrl: `/api/gallery/${p._id}/thumb`,
    caption: p.caption,
    order: p.order,
    eventId: p.eventId,
    byPersonId: p.byPersonId,
    createdAt: p.createdAt,
  };
}

/** May this session upload / edit / publish photos? (the admin or a listed photographer) */
async function canManage(c: Context<Env>): Promise<boolean> {
  const role = c.get("activeRole");
  if (role === "admin") return true;
  if (role !== "staff") return false;
  const scope = await resolveScope(c.get("user"));
  return scope.all || scope.photographer;
}

gallery.use("*", async (c, next) => {
  // the thumbnail is inside an <img> tag (no Authorization header possible) and
  // the photo id is unguessable — exactly like GET /api/files/:id, it stays public
  if (c.req.path.endsWith("/thumb")) return next();
  return requireAuth(c, next);
});

/**
 * GET /api/gallery — everyone logged in; the album only reaches parents
 * and the team once it is published (settings.galleryPublished).
 */
gallery.get("/", async (c) => {
  if (!(await canManage(c)) && !(await getSettings()).galleryPublished) return c.json({ photos: [] });
  return c.json({ photos: (await listGalleryPhotos()).map(serializePhoto) });
});

/** POST /api/gallery — the photographer sends one picture at a time. */
gallery.post("/", async (c) => {
  if (!(await canManage(c))) return fail(c, "FORBIDDEN", "Só os fotógrafos escolhidos nas configurações podem enviar fotos.", 403);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  const thumb = form?.get("thumb");
  if (!(file instanceof File)) return fail(c, "FILE_MISSING", "Envie a imagem no campo 'file'.");
  if (!ALLOWED.has(file.type)) return fail(c, "FILE_TYPE", "Só imagens JPG, PNG, WebP ou GIF.", 415);
  if (file.size > MAX_BYTES) return fail(c, "FILE_TOO_LARGE", "Imagem muito grande (máx. 2 MB).", 413);
  if (!(thumb instanceof File) || !ALLOWED.has(thumb.type) || thumb.size > MAX_THUMB_BYTES) {
    return fail(c, "THUMB_INVALID", "Envie a miniatura da imagem no campo 'thumb'.");
  }

  const caption = (typeof form?.get("caption") === "string" ? String(form.get("caption")) : "").trim().slice(0, CAPTION_MAX);
  const eventIdRaw = form?.get("eventId");
  let eventId: string | null = null;
  if (typeof eventIdRaw === "string" && eventIdRaw) {
    const event = await findEventById(eventIdRaw);
    if (!event) return fail(c, "EVENT_INVALID", "Evento não encontrado.");
    eventId = event._id;
  }
  const stored = await insertFile({ name: file.name.slice(0, 120), type: file.type, data: new Uint8Array(await file.arrayBuffer()), byPersonId: c.get("userId") });
  const photo = await insertGalleryPhoto({
    fileId: stored._id,
    thumb: new Uint8Array(await thumb.arrayBuffer()),
    thumbType: thumb.type,
    caption,
    eventId,
    byPersonId: c.get("userId"),
  });
  void indexGalleryPhotoFaces(photo._id, photo.fileId);
  publish("gallery");
  return c.json({ photo: serializePhoto(photo) }, 201);
});

/**
 * PUT /api/gallery/publish — { published: boolean }. The album switch on the
 * Fotos tab: `true` shows every photo to the camp at once (ONE SMS goes out
 * naming how many became visible); `false` hides the album again (no SMS).
 * Registered BEFORE /:id so "publish" is not taken for a photo id.
 */
gallery.put("/publish", async (c) => {
  if (!(await canManage(c))) return fail(c, "FORBIDDEN", "Só os fotógrafos escolhidos nas configurações podem publicar as fotos.", 403);
  const body = await c.req.json<{ published?: unknown }>().catch(() => null);
  if (!body || typeof body.published !== "boolean") return fail(c, "PUBLISHED_INVALID", "A publicação deve ser ligada ou desligada.");
  const was = (await getSettings()).galleryPublished;
  await updateSettings({ galleryPublished: body.published });
  const count = (await listGalleryPhotos()).length;
  publish("gallery");
  publish("settings");
  // only the transition off → on tells the camp, and only with something to show
  if (body.published && !was && count > 0) void notifyPhotosPublished(count);
  return c.json({ published: body.published, count });
});

/**
 * A parent sends one temporary reference picture to FILTER the album they
 * already see. Only matched photo ids are returned; the image and its
 * embedding are never stored.
 */
gallery.post("/search-person", async (c) => {
  if (c.get("activeRole") !== "parent") return fail(c, "FORBIDDEN", "A busca por rosto está disponível para os responsáveis.", 403);
  if (!(await getSettings()).galleryPublished) return c.json({ matches: [], indexedFaces: 0, pendingPhotos: 0 });
  if (!faceRecognitionEnabled()) return fail(c, "FACE_SEARCH_UNAVAILABLE", "A busca por rosto está indisponível no momento.", 503);

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("reference");
  if (!(file instanceof File)) return fail(c, "REFERENCE_MISSING", "Escolha uma foto de referência.");
  if (!ALLOWED.has(file.type)) return fail(c, "FILE_TYPE", "Use uma imagem JPG, PNG, WebP ou GIF.", 415);
  if (file.size > MAX_REFERENCE_BYTES) return fail(c, "FILE_TOO_LARGE", "A foto de referência é muito grande (máx. 5 MB).", 413);

  let result;
  try {
    result = await extractFaceEmbeddings(new Uint8Array(await file.arrayBuffer()), file.type, file.name);
  } catch (error) {
    console.error("Face search failed", error);
    return fail(c, "FACE_SEARCH_FAILED", "Não consegui analisar a foto. Tente novamente.", 503);
  }
  const usable = result.faces.filter((face) => face.detScore >= config.face.minDetectionScore);
  if (usable.length === 0) return fail(c, "FACE_NOT_FOUND", "Não encontrei um rosto nítido nessa foto.");
  if (usable.length > 1) return fail(c, "MULTIPLE_FACES", "Use uma foto com apenas uma pessoa.");

  const indexed = await listGalleryFaceEmbeddings();
  const best = new Map<string, number>();
  for (const face of indexed) {
    const score = cosineSimilarity(usable[0].embedding, face.embedding);
    if (score >= config.face.matchThreshold && score > (best.get(face.photoId) ?? -1)) best.set(face.photoId, score);
  }
  const allPhotos = await listGalleryPhotos();
  const allIds = new Set(allPhotos.map((photo) => photo._id));
  const photoById = new Map(allPhotos.map((photo) => [photo._id, photo]));
  const matches = [...best.entries()]
    .filter(([photoId]) => allIds.has(photoId))
    .sort((a, b) => b[1] - a[1])
    .map(([photoId, similarity]) => ({ photo: serializePhoto(photoById.get(photoId)!), similarity: Number(similarity.toFixed(4)) }));
  const pendingPhotos = (await listUnindexedGalleryPhotos(allPhotos.length)).length;
  return c.json({ matches, indexedFaces: indexed.length, pendingPhotos });
});

/** Reads and validates the `ids` array shared by both bulk routes. */
async function bulkIds(c: Context): Promise<{ ids: string[] } | { error: Response }> {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.ids)) return { error: fail(c, "IDS_INVALID", "Envie a lista de fotos.") };
  if (body.ids.length > BULK_MAX) return { error: fail(c, "IDS_TOO_MANY", `Selecione no máximo ${BULK_MAX} fotos por vez.`) };
  const ids = validGalleryIds(body.ids as string[]);
  if (ids.length === 0) return { error: fail(c, "IDS_EMPTY", "Nenhuma foto selecionada.") };
  return { ids };
}

/**
 * PUT /api/gallery/bulk — { ids, eventId? ("" = general) }
 * Moves a whole selection to an event in one request.
 * Registered BEFORE /:id so "bulk" is not taken for a photo id.
 */
gallery.put("/bulk", async (c) => {
  if (!(await canManage(c))) return fail(c, "FORBIDDEN", "Só os fotógrafos escolhidos nas configurações podem editar as fotos.", 403);
  const parsed = await bulkIds(c);
  if ("error" in parsed) return parsed.error;
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const patch: { eventId?: string | null } = {};
  if (body.eventId !== undefined) {
    if (body.eventId === null || body.eventId === "") patch.eventId = null;
    else if (typeof body.eventId === "string") {
      const event = await findEventById(body.eventId);
      if (!event) return fail(c, "EVENT_INVALID", "Evento não encontrado.");
      patch.eventId = event._id;
    } else return fail(c, "EVENT_INVALID", "Evento inválido.");
  }
  if (patch.eventId === undefined) return fail(c, "NOTHING_TO_UPDATE", "Nada para atualizar.");

  const count = await updateGalleryPhotos(parsed.ids, patch);
  publish("gallery");
  return c.json({ count });
});

/**
 * POST /api/gallery/bulk-delete — { ids }. Drops the photos AND their
 * full-size files. POST (not DELETE) so the body is never stripped.
 */
gallery.post("/bulk-delete", async (c) => {
  if (!(await canManage(c))) return fail(c, "FORBIDDEN", "Só os fotógrafos escolhidos nas configurações podem excluir as fotos.", 403);
  const parsed = await bulkIds(c);
  if ("error" in parsed) return parsed.error;
  const deleted = await deleteGalleryPhotos(parsed.ids);
  await Promise.all(deleted.map((p) => deleteFile(p.fileId)));
  if (deleted.length > 0) publish("gallery");
  return c.json({ count: deleted.length });
});

/**
 * PUT /api/gallery/reorder — { ids }. The photos of ONE section in their new
 * order (first = shown first). Registered BEFORE /:id.
 */
gallery.put("/reorder", async (c) => {
  if (!(await canManage(c))) return fail(c, "FORBIDDEN", "Só os fotógrafos escolhidos nas configurações podem reordenar as fotos.", 403);
  const parsed = await bulkIds(c);
  if ("error" in parsed) return parsed.error;
  const count = await reorderGalleryPhotos(parsed.ids);
  if (count > 0) publish("gallery");
  return c.json({ count });
});

/** PUT /api/gallery/:id — { caption?, eventId? ("" = general), published? } */
gallery.put("/:id", async (c) => {
  if (!(await canManage(c))) return fail(c, "FORBIDDEN", "Só os fotógrafos escolhidos nas configurações podem editar as fotos.", 403);
  const existing = await findGalleryPhoto(c.req.param("id"));
  if (!existing) return fail(c, "PHOTO_NOT_FOUND", "Foto não encontrada.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  let touched = false;
  let eventId = existing.eventId;
  if (body.eventId !== undefined) {
    if (body.eventId === null || body.eventId === "") {
      eventId = null;
      touched = true;
    } else if (typeof body.eventId === "string") {
      const event = await findEventById(body.eventId);
      if (!event) return fail(c, "EVENT_INVALID", "Evento não encontrado.");
      eventId = event._id;
      touched = true;
    }
  }
  let caption = existing.caption;
  if (body.caption !== undefined) {
    if (typeof body.caption !== "string") return fail(c, "CAPTION_INVALID", "A legenda deve ser um texto.");
    caption = body.caption.trim().slice(0, CAPTION_MAX);
    touched = true;
  }
  if (!touched) return fail(c, "NOTHING_TO_UPDATE", "Nada para atualizar.");

  const updated = await updateGalleryPhoto(existing._id, { caption, eventId });
  publish("gallery");
  return c.json({ photo: serializePhoto(updated!) });
});

/** DELETE /api/gallery/:id — drops the photo AND its full-size file. */
gallery.delete("/:id", async (c) => {
  if (!(await canManage(c))) return fail(c, "FORBIDDEN", "Só os fotógrafos escolhidos nas configurações podem excluir as fotos.", 403);
  const existing = await findGalleryPhoto(c.req.param("id"));
  if (!existing) return fail(c, "PHOTO_NOT_FOUND", "Foto não encontrada.", 404);
  await deleteGalleryPhoto(existing._id);
  await deleteFile(existing.fileId);
  publish("gallery");
  return c.json({ success: true });
});

// ── thumbnail (public: the photo id is unguessable, and an <img> cannot send headers) ──

gallery.get("/:id/thumb", async (c) => {
  const t = await findGalleryPhotoThumb(c.req.param("id"));
  if (!t || t.thumb.byteLength === 0) return fail(c, "PHOTO_NOT_FOUND", "Foto não encontrada.", 404);
  return new Response(new Blob([t.thumb as BlobPart], { type: t.thumbType }), {
    headers: {
      "content-type": t.thumbType,
      "content-length": String(t.thumb.byteLength),
      // photos are immutable → cache forever
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});

/** Called by the schedule route when an event is deleted: its photos become general. */
export async function onEventDeleted(eventId: string): Promise<void> {
  const n = await detachGalleryFromEvent(eventId);
  if (n > 0) publish("gallery");
}

export default gallery;
