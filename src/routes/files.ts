import { Hono, type Context } from "hono";
import { requireAuth } from "../middleware/auth";
import { findFileWithData, insertFile } from "../models/files";
import { resolveScope } from "../services/scope";
import type { Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

/**
 * Images for the rich-text editor.
 *
 *   POST /api/files          (admin / organizer / medical, multipart "file")
 *   GET  /api/files/:id      (public — the id is unguessable; see models/files.ts)
 *
 * The frontend shrinks the picture (canvas, ≤ 1280 px, JPEG/WebP) before
 * sending, so the limit here is a safety net rather than the expected size.
 */
const files = new Hono<Env>();

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function fail(c: Context, code: string, message: string, status: 400 | 404 | 413 | 415 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeFile(f: { _id: string; name: string; type: string; size: number; createdAt: Date }) {
  return { id: f._id, url: `/api/files/${f._id}`, name: f.name, type: f.type, size: f.size, createdAt: f.createdAt };
}

files.post("/", requireAuth, async (c) => {
  const role = c.get("activeRole");
  if (role !== "admin") {
    if (role !== "staff") {
      return c.json({ error: { code: "FORBIDDEN", message: "Você não tem permissão para enviar imagens." } }, 403);
    }
    const scope = await resolveScope(c.get("user"));
    if (!scope.all && !scope.organizer && !scope.medical) {
      return c.json({ error: { code: "FORBIDDEN", message: "Só a organização e a equipe médica podem enviar imagens." } }, 403);
    }
  }
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return fail(c, "FILE_MISSING", "Envie a imagem no campo 'file'.");
  if (!ALLOWED.has(file.type)) return fail(c, "FILE_TYPE", "Só imagens JPG, PNG, WebP ou GIF.", 415);
  if (file.size > MAX_BYTES) return fail(c, "FILE_TOO_LARGE", "Imagem muito grande (máx. 2 MB).", 413);

  const data = new Uint8Array(await file.arrayBuffer());
  const stored = await insertFile({ name: file.name.slice(0, 120), type: file.type, data, byPersonId: c.get("userId") });
  return c.json({ file: serializeFile(stored) }, 201);
});

files.get("/:id", async (c) => {
  const f = await findFileWithData(c.req.param("id"));
  if (!f) return fail(c, "FILE_NOT_FOUND", "Imagem não encontrada.", 404);
  return new Response(new Blob([f.data as BlobPart], { type: f.type }), {
    headers: {
      "content-type": f.type,
      "content-length": String(f.size),
      // ids are immutable → cache forever (the service worker keeps them for offline use too)
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});

export default files;
