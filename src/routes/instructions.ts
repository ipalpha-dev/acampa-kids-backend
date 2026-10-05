import { Hono, type Context } from "hono";
import { requireAuth } from "../middleware/auth";
import { requireManager, requireRole } from "../middleware/roles";
import {
  deleteInstruction,
  findInstructionById,
  insertInstruction,
  listInstructions,
  nextInstructionOrder,
  updateInstruction,
  type InstructionData,
} from "../models/instructions";
import { cleanHtml } from "../services/html";
import { publish } from "../services/realtime";
import { canSeeDoc, resolveScope } from "../services/scope";
import { notifyInstructionChange } from "../services/notify";
import { isEmojiLike } from "../utils";
import { DOC_AUDIENCES, type DocAudience, type InstructionDoc, type Role, type SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

/**
 * Instruções — general documents for the whole camp ("Regras", "Plano de
 * emergência", "Rotina do dia"…). Big rich-text documents the admin writes and
 * every team member reads. Unlike Preparação they are not a checklist: the
 * list shows titles, tapping one opens the whole document.
 *
 *   GET    /api/instructions              team + admin
 *   POST   /api/instructions              admin   { title, emoji?, content? }
 *   PUT    /api/instructions/reorder      admin   { ids }
 *   PUT    /api/instructions/:id          admin
 *   DELETE /api/instructions/:id          admin
 */
const instructions = new Hono<Env>();

const TITLE_MAX = 120;
/** big documents: room for many pictures (they are downscaled client-side) */
const CONTENT_MAX = 400_000;

function fail(c: Context, code: string, message: string, status: 400 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeInstruction(d: InstructionDoc) {
  return {
    id: d._id,
    title: d.title,
    emoji: d.emoji,
    audience: d.audience,
    content: d.content,
    order: d.order,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function buildPatch(body: Record<string, unknown>, partial: boolean): { patch: Partial<InstructionData> } | { code: string; message: string } {
  const patch: Partial<InstructionData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("title")) {
    const t = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
    if (!t || t.length > TITLE_MAX) return { code: "TITLE_INVALID", message: `Informe um título com até ${TITLE_MAX} caracteres.` };
    patch.title = t;
  }
  if (has("emoji")) {
    const e = typeof body.emoji === "string" ? body.emoji.trim() : "";
    patch.emoji = isEmojiLike(e) ? e : "📖";
  }
  if (has("audience")) {
    const a = body.audience === undefined ? "all" : body.audience;
    if (!DOC_AUDIENCES.includes(a as DocAudience)) return { code: "AUDIENCE_INVALID", message: "Público deve ser todos, responsáveis ou auxiliares." };
    patch.audience = a as DocAudience;
  }
  if (has("content")) {
    const html = cleanHtml(body.content, CONTENT_MAX);
    if (html === null) return { code: "CONTENT_INVALID", message: "Conteúdo inválido ou muito longo." };
    patch.content = html;
  }
  return { patch };
}

instructions.use("*", requireAuth);

instructions.get("/", requireRole("admin", "staff"), async (c) => {
  const [list, scope] = await Promise.all([listInstructions(), resolveScope(c.get("user"))]);
  return c.json({ instructions: list.filter((d) => canSeeDoc(scope, d)).map(serializeInstruction) });
});

instructions.post("/", requireManager, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const created = await insertInstruction({ ...(result.patch as InstructionData), order: await nextInstructionOrder() });
  publish("instructions");
  void notifyInstructionChange(null, created);
  return c.json({ instruction: serializeInstruction(created) }, 201);
});

/** PUT /api/instructions/reorder  { ids: string[] } — must be declared before /:id */
instructions.put("/reorder", requireManager, async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return fail(c, "IDS_INVALID", "Envie a lista de ids.");
  const existing = await listInstructions();
  const known = new Set(existing.map((d) => d._id));
  const ordered = (ids as string[]).filter((id) => known.has(id));
  const rest = existing.map((d) => d._id).filter((id) => !ordered.includes(id));
  await Promise.all([...ordered, ...rest].map((id, order) => updateInstruction(id, { order })));
  publish("instructions");
  return c.json({ instructions: (await listInstructions()).map(serializeInstruction) });
});

instructions.put("/:id", requireManager, async (c) => {
  const existing = await findInstructionById(c.req.param("id"));
  if (!existing) return fail(c, "INSTRUCTION_NOT_FOUND", "Documento não encontrado.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = buildPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const updated = await updateInstruction(existing._id, result.patch);
  publish("instructions");
  void notifyInstructionChange(existing, updated!);
  return c.json({ instruction: serializeInstruction(updated!) });
});

instructions.delete("/:id", requireManager, async (c) => {
  const ok = await deleteInstruction(c.req.param("id"));
  if (!ok) return fail(c, "INSTRUCTION_NOT_FOUND", "Documento não encontrado.", 404);
  publish("instructions");
  return c.json({ success: true });
});

export default instructions;
