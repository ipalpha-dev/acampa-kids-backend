import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireManager, requireRole } from "../middleware/roles";
import {
  deletePrepSection,
  findPrepSectionById,
  insertPrepSection,
  listPrepSections,
  nextPrepOrder,
  updatePrepSection,
  type PrepSectionData,
} from "../models/preparation";
import { cleanHtml } from "../services/html";
import { publish } from "../services/realtime";
import { canSeePrep, isParent, prepDoneOf, resolveScope, type Scope } from "../services/scope";
import { notifyPreparationChange } from "../services/notify";
import { setUserPrepDoneState } from "../models/userCampState";
import { clearPrepDoneKey } from "../models/preparation";
import { isEmojiLike } from "../utils";
import { PREP_AUDIENCES, PREP_TEAM_AUDIENCES, type PrepAudience, type PrepSection } from "../types";

type Env = { Variables: AuthVariables };

/**
 * Preparação — general sections read before the camp ("O que levar",
 * "Chegada", "Uniforme"…), each POSTED to one or more groups (`audiences`:
 * parents, caretakers, helpers). Role-specific preparation lives on the role
 * itself (PUT /api/schedule/roles/:id { preparation }).
 *
 *   GET    /api/preparation              team + parents + admin (filtered to what the session may see)
 *   PUT    /api/preparation/me/:key      parent  { done: boolean } — ticks one item of THEIR checklist
 *   POST   /api/preparation              admin   { title, emoji?, audiences?, content? }
 *   PUT    /api/preparation/reorder      admin   { ids }
 *   PUT    /api/preparation/:id          admin
 *   DELETE /api/preparation/:id          admin
 */
const preparation = new Hono<Env>();

const TITLE_MAX = 80;
const CONTENT_MAX = 60_000;

function fail(c: Context, code: string, message: string, status: 400 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializePrepSection(s: PrepSection, done?: Set<string>) {
  return {
    id: s._id,
    title: s.title,
    emoji: s.emoji,
    audiences: s.audiences,
    content: s.content,
    order: s.order,
    /** PARENT sessions only: has this responsible already ticked the item? (the team's ticks live on `staff.prepDone`) */
    done: done ? done.has(`section:${s._id}`) : false,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** The sections this session may read, each already carrying its own ✓ for a parent. */
export function serializePrepListFor(list: PrepSection[], scope: Scope) {
  const done = isParent(scope) ? new Set(prepDoneOf(scope)) : undefined;
  return list.filter((s) => canSeePrep(scope, s)).map((s) => serializePrepSection(s, done));
}

function buildPatch(body: Record<string, unknown>, partial: boolean): { patch: Partial<PrepSectionData> } | { code: string; message: string } {
  const patch: Partial<PrepSectionData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("title")) {
    const t = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
    if (!t || t.length > TITLE_MAX) return { code: "TITLE_INVALID", message: `Informe um título com até ${TITLE_MAX} caracteres.` };
    patch.title = t;
  }
  if (has("emoji")) {
    const e = typeof body.emoji === "string" ? body.emoji.trim() : "";
    patch.emoji = isEmojiLike(e) ? e : "📌";
  }
  if (has("audiences")) {
    const raw = body.audiences === undefined ? PREP_TEAM_AUDIENCES : body.audiences;
    if (!Array.isArray(raw) || raw.some((a) => !PREP_AUDIENCES.includes(a as PrepAudience))) return { code: "AUDIENCE_INVALID", message: "Público deve ser pais, líderes e/ou auxiliares." };
    const audiences = PREP_AUDIENCES.filter((a) => (raw as unknown[]).includes(a));
    if (audiences.length === 0) return { code: "AUDIENCE_INVALID", message: "Escolha pelo menos um público para a seção." };
    patch.audiences = audiences;
  }
  if (has("content")) {
    const html = cleanHtml(body.content, CONTENT_MAX);
    if (html === null) return { code: "CONTENT_INVALID", message: "Conteúdo inválido ou muito longo." };
    patch.content = html;
  }
  return { patch };
}

preparation.use("*", requireAuth);

preparation.get("/", requireRole("admin", "staff", "parent"), async (c) => {
  const scope = await resolveScope(c.get("user"));
  return c.json({ sections: serializePrepListFor(await listPrepSections(), scope) });
});

/**
 * PUT /api/preparation/me/:key  { done: boolean } — a PARENT ticks / unticks
 * one item of their own checklist (`key` is "section:<id>"). The team's
 * equivalent is PUT /api/staff/me/prep/:key (stored on the staff record).
 * Must be declared before /:id.
 */
preparation.put("/me/:key", requireRole("parent"), async (c) => {
  const key = c.req.param("key");
  if (!/^section:[a-f0-9]{24}$/.test(key)) return fail(c, "KEY_INVALID", "Item inválido.");
  const body = await c.req.json<{ done?: unknown }>().catch(() => null);
  if (!body || typeof body.done !== "boolean") return fail(c, "BODY_INVALID", "Envie { done: true | false }.");
  const section = await findPrepSectionById(key.slice("section:".length));
  const scope = await resolveScope(c.get("user"));
  if (!section || !canSeePrep(scope, section)) return fail(c, "SECTION_NOT_FOUND", "Seção não encontrada.", 404);
  const updated = await setUserPrepDoneState(c.get("user").personId, key, body.done);
  // only this parent's payload changes; publish re-sends the collection to everyone (cheap, ~10 sections)
  publish("preparation");
  return c.json({ done: (updated?.prepDone ?? []).includes(key) });
});

preparation.post("/", requireManager, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const created = await insertPrepSection({ ...(result.patch as PrepSectionData), order: await nextPrepOrder() });
  publish("preparation");
  void notifyPreparationChange(null, created);
  return c.json({ section: serializePrepSection(created) }, 201);
});

/** PUT /api/preparation/reorder  { ids: string[] } — must be declared before /:id */
preparation.put("/reorder", requireManager, async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return fail(c, "IDS_INVALID", "Envie a lista de ids.");
  const existing = await listPrepSections();
  const known = new Set(existing.map((s) => s._id));
  const ordered = (ids as string[]).filter((id) => known.has(id));
  const rest = existing.map((s) => s._id).filter((id) => !ordered.includes(id));
  await Promise.all([...ordered, ...rest].map((id, order) => updatePrepSection(id, { order })));
  publish("preparation");
  return c.json({ sections: (await listPrepSections()).map((s) => serializePrepSection(s)) });
});

preparation.put("/:id", requireManager, async (c) => {
  const existing = await findPrepSectionById(c.req.param("id"));
  if (!existing) return fail(c, "SECTION_NOT_FOUND", "Seção não encontrada.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = buildPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const updated = await updatePrepSection(existing._id, result.patch);
  publish("preparation");
  void notifyPreparationChange(existing, updated!);
  return c.json({ section: serializePrepSection(updated!) });
});

preparation.delete("/:id", requireManager, async (c) => {
  const id = c.req.param("id");
  const ok = await deletePrepSection(id);
  if (!ok) return fail(c, "SECTION_NOT_FOUND", "Seção não encontrada.", 404);
  // the checklist ticks of the team and of the parents point at a section that no longer exists
  await clearPrepDoneKey(`section:${id}`);
  publish("preparation", "staff");
  return c.json({ success: true });
});

export default preparation;
