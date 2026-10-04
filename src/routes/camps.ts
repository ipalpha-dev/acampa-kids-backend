import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { requireAuth } from "../middleware/auth";
import { requireManager } from "../middleware/roles";
import {
  activateCamp,
  campCounts,
  clearCampDeleteOtp,
  createCamp,
  findCamp,
  getCampDeleteOtp,
  listCamps,
  setCampDeleteOtp,
  updateCamp,
  type Camp,
} from "../models/camps";
import { updateSettings } from "../models/settings";
import { activeCamp, inHistoryCamp, withCamp } from "../services/campContext";
import { canSwitchCamps } from "../services/campAccess";
import { comteleEnabled, comteleSendSms } from "../services/comtele";
import { deleteCamp, evaluateCampDeleteCode } from "../services/campDelete";
import { IMPORT_BLOCKS, campSummary, importFromCamp, searchCampCampers, searchCampStaff, type ImportBlock, type ImportOptions } from "../services/campImport";
import { generateLocalCode, hashCode } from "../services/otp";
import { rearmActiveCampTimers } from "../services/realtime";
import { rolloverEdition } from "../services/ipalpha";
import { sms, smsPrefix } from "../i18n";
import type { Role, SessionUser } from "../types";
import { formatBrazilPhone } from "../utils";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
    campId: string;
    targetCamp: Camp;
  };
}

const camps = new Hono<Env>();

function serializeCamp(c: Pick<Camp, "_id" | "label" | "year">): { id: string; label: string; year: number } {
  return { id: c._id, label: c.label, year: c.year };
}

function serializeCampFull(c: Camp): { id: string; label: string; year: number; active: boolean; archivedAt: string | null } {
  return { ...serializeCamp(c), active: c.active, archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null };
}

/** the global admin role only (super admin included — it's just the account whose phone matches SUPER_ADMIN_PHONE) */
const requireGlobalAdmin = createMiddleware<Env>(async (c, next) => {
  if (!c.get("user").roles.includes("admin")) {
    return c.json({ error: { code: "FORBIDDEN", message: "Só administradores podem gerenciar acampamentos." } }, 403);
  }
  await next();
});

const DELETE_CODE_MINUTES = 5;

/** GET /api/camps/active — public, for the login screen. */
camps.get("/active", (c) => c.json(serializeCamp(activeCamp())));

/**
 * GET /api/camps — admin or an active-camp organizer (see canSwitchCamps).
 * Every camp with its counts; `canEnter` is always true for a caller who
 * passed the guard (there is no per-camp restriction beyond that).
 */
camps.get("/", requireAuth, async (c) => {
  if (!(await canSwitchCamps(c.get("user"), c.get("activeRole")))) {
    return c.json({ error: { code: "CAMP_FORBIDDEN", message: "Só a organização pode ver outros anos." } }, 403);
  }
  const list = await listCamps();
  const withCounts = await Promise.all(
    list.map(async (camp) => ({
      ...serializeCampFull(camp),
      counts: await campCounts(camp._id),
      canEnter: true,
    })),
  );
  return c.json({ camps: withCounts });
});

/**
 * POST /api/camps  { label, year } — admin. Creates the camp, makes it active
 * (archiving the previous one), writes its default settings and re-arms the
 * runtime timers for it.
 */
camps.post("/", requireAuth, requireGlobalAdmin, async (c) => {
  const body = await c.req.json<{ label?: unknown; year?: unknown }>().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const year = body?.year;
  if (label.length < 1 || label.length > 80) {
    return c.json({ error: { code: "LABEL_INVALID", message: "Informe um nome com até 80 caracteres." } }, 400);
  }
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100) {
    return c.json({ error: { code: "YEAR_INVALID", message: "Informe um ano entre 2000 e 2100." } }, 400);
  }

  const created = await createCamp({ label, year, createdByUserId: c.get("userId") });
  await activateCamp(created._id);
  await withCamp(created._id, () => updateSettings({ wizardMode: false }));
  await rearmActiveCampTimers();
  // IPAlpha: this year's edition becomes the project's current one (best effort, never blocks)
  void rolloverEdition(created.year);

  return c.json({ camp: serializeCampFull((await findCamp(created._id)) ?? created) }, 201);
});

/**
 * PUT /api/camps/:id  { label?, year?, active?: true, archived?: boolean } — admin.
 */
camps.put("/:id", requireAuth, requireGlobalAdmin, async (c) => {
  const id = c.req.param("id");
  const existing = await findCamp(id);
  if (!existing) return c.json({ error: { code: "CAMP_NOT_FOUND", message: "Acampamento não encontrado." } }, 404);

  const body = await c.req.json<{ label?: unknown; year?: unknown; active?: unknown; archived?: unknown }>().catch(() => null);
  const label = body?.label !== undefined ? (typeof body.label === "string" ? body.label.trim() : null) : undefined;
  if (label !== undefined && (label === null || label.length < 1 || label.length > 80)) {
    return c.json({ error: { code: "LABEL_INVALID", message: "Informe um nome com até 80 caracteres." } }, 400);
  }
  const year = body?.year !== undefined ? body.year : undefined;
  if (year !== undefined && (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100)) {
    return c.json({ error: { code: "YEAR_INVALID", message: "Informe um ano entre 2000 e 2100." } }, 400);
  }
  if (body?.archived === true && existing.active) {
    return c.json({ error: { code: "CAMP_ACTIVE", message: "Torne outro acampamento ativo primeiro." } }, 409);
  }

  if (body?.active === true) {
    await activateCamp(id);
    await rearmActiveCampTimers();
  }

  const patch: { label?: string; year?: number; archived?: boolean } = {};
  if (typeof label === "string") patch.label = label;
  if (typeof year === "number") patch.year = year;
  if (typeof body?.archived === "boolean") patch.archived = body.archived;
  const updated = Object.keys(patch).length ? await updateCamp(id, patch) : await findCamp(id);
  // IPAlpha: the activated camp's year becomes the project's current edition (best effort, never blocks)
  if (body?.active === true && updated) void rolloverEdition(updated.year);

  return c.json({ camp: serializeCampFull(updated!) });
});

/**
 * POST /api/camps/:id/delete/request — admin, target must not be active.
 * Sends a 6-digit code, valid 5 minutes, to the CALLER's own phone.
 */
camps.post("/:id/delete/request", requireAuth, requireGlobalAdmin, async (c) => {
  const id = c.req.param("id");
  const target = await findCamp(id);
  if (!target) return c.json({ error: { code: "CAMP_NOT_FOUND", message: "Acampamento não encontrado." } }, 404);
  if (target.active) return c.json({ error: { code: "CAMP_ACTIVE", message: "Torne outro acampamento ativo primeiro." } }, 409);

  const user = c.get("user");
  const code = generateLocalCode();
  const expiresAt = new Date(Date.now() + DELETE_CODE_MINUTES * 60_000);
  await setCampDeleteOtp(id, { codeHash: hashCode(code), requestedByUserId: c.get("userId"), expiresAt, attempts: 0 });

  const viaSms = comteleEnabled();
  if (viaSms) {
    const result = await comteleSendSms(user.phone, sms(user.locale, "otp", { prefix: smsPrefix(), code, minutes: DELETE_CODE_MINUTES }));
    if (!result.ok) {
      await clearCampDeleteOtp(id);
      console.error("[comtele] delete-camp code failed:", result.message);
      return c.json({ error: { code: "SMS_SEND_FAILED", message: "Não foi possível enviar o SMS agora. Tente novamente em instantes." } }, 502);
    }
  } else {
    console.log(`🔐 delete-camp code for ${target.label}: ${code}`);
  }

  return c.json({ success: true, phone: formatBrazilPhone(user.phone), expiresAt: expiresAt.toISOString(), delivery: viaSms ? "sms" : "mock" });
});

/**
 * POST /api/camps/:id/delete/confirm  { code } — admin. Wipes the camp on a
 * matching, unexpired code from the same requester (3 attempts, 5 minutes).
 */
camps.post("/:id/delete/confirm", requireAuth, requireGlobalAdmin, async (c) => {
  const id = c.req.param("id");
  const target = await findCamp(id);
  if (!target) return c.json({ error: { code: "CAMP_NOT_FOUND", message: "Acampamento não encontrado." } }, 404);
  if (target.active) return c.json({ error: { code: "CAMP_ACTIVE", message: "Torne outro acampamento ativo primeiro." } }, 409);

  const body = await c.req.json<{ code?: unknown }>().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.replace(/\D/g, "") : "";

  const otp = await getCampDeleteOtp(id);
  const result = evaluateCampDeleteCode(otp, c.get("userId"), code);
  if (!result.ok) {
    if (result.clear) await clearCampDeleteOtp(id);
    else if (result.attempts !== undefined) await setCampDeleteOtp(id, { ...otp!, attempts: result.attempts });
    return c.json({ error: result.error }, result.error.status);
  }

  await clearCampDeleteOtp(id);
  const user = c.get("user");
  const removed = await deleteCamp(id);
  console.log(`🗑️ camp "${target.label}" deleted by ${user.name} (${user.phone})`, removed);
  return c.json({ success: true, removed });
});

/** The `:id` camp exists and differs from the session's own — every cross-year import route needs both. */
const requireOtherCamp = createMiddleware<Env>(async (c, next) => {
  const id = c.req.param("id") ?? "";
  const target = await findCamp(id);
  if (!target) return c.json({ error: { code: "CAMP_NOT_FOUND", message: "Acampamento não encontrado." } }, 404);
  if (id === c.get("campId")) return c.json({ error: { code: "SAME_CAMP", message: "Escolha um ano diferente do atual." } }, 400);
  c.set("targetCamp", target);
  await next();
});

/** GET /api/camps/:id/summary — counts per importable block of `:id`. */
camps.get("/:id/summary", requireAuth, requireManager, requireOtherCamp, async (c) => {
  const target = c.get("targetCamp");
  const counts = await campSummary(target._id);
  return c.json({ camp: serializeCamp(target), counts });
});

/** GET /api/camps/:id/campers?q= — the pickers behind "Acampantes → Outro ano". */
camps.get("/:id/campers", requireAuth, requireManager, requireOtherCamp, async (c) => {
  const target = c.get("targetCamp");
  const rows = await searchCampCampers(target._id, c.req.query("q") ?? "");
  return c.json({ rows });
});

/** GET /api/camps/:id/staff?q= — the pickers behind "Equipe → Outro ano". */
camps.get("/:id/staff", requireAuth, requireManager, requireOtherCamp, async (c) => {
  const target = c.get("targetCamp");
  const rows = await searchCampStaff(target._id, c.req.query("q") ?? "");
  return c.json({ rows });
});

/**
 * POST /api/camps/:id/import — the copy engine (see services/campImport.ts).
 * Only allowed from the ACTIVE camp: importing INTO an archived year makes no sense.
 */
camps.post("/:id/import", requireAuth, requireManager, requireOtherCamp, async (c) => {
  if (inHistoryCamp()) return c.json({ error: { code: "CAMP_ARCHIVED", message: "Este ano está arquivado — só leitura." } }, 403);
  const target = c.get("targetCamp");

  const body = await c.req.json<{ blocks?: unknown; camperIds?: unknown; staffIds?: unknown; withRoles?: unknown; withAssignments?: unknown; onMatch?: unknown }>().catch(() => null);
  const camperIds = Array.isArray(body?.camperIds) ? body.camperIds.filter((x): x is string => typeof x === "string") : [];
  const staffIds = Array.isArray(body?.staffIds) ? body.staffIds.filter((x): x is string => typeof x === "string") : [];
  const requestedBlocks = new Set<ImportBlock>(Array.isArray(body?.blocks) ? body.blocks.filter((b): b is ImportBlock => IMPORT_BLOCKS.includes(b)) : []);
  if (camperIds.length) requestedBlocks.add("campers");
  if (staffIds.length) requestedBlocks.add("staff");
  if (requestedBlocks.size === 0) {
    return c.json({ error: { code: "BLOCKS_REQUIRED", message: "Escolha ao menos um bloco para importar." } }, 400);
  }

  const opts: ImportOptions = {
    blocks: [...requestedBlocks],
    camperIds: camperIds.length ? camperIds : undefined,
    staffIds: staffIds.length ? staffIds : undefined,
    withRoles: body?.withRoles !== false,
    withAssignments: body?.withAssignments === true,
    onMatch: body?.onMatch === "update" ? "update" : "skip",
  };

  const result = await importFromCamp(target._id, opts, c.get("userId"));
  return c.json({ result });
});

export default camps;
