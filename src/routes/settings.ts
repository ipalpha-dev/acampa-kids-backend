import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireAdmin, requireManager } from "../middleware/roles";
import { listTransports } from "../models/transports";
import { checkinWindowOpen, getSettings, scoreHidden, staffAccessOpen, updateSettings } from "../models/settings";
import { FOREIGN_LOOKUP_ALERT_AT, listForeignLookupOffenders, listStaff, resetForeignLookups, resetStaffCheckins, resetStaffPhotosNotice, resetStaffVests } from "../models/staff";
import { clearCheckinLog, resetCamperCheckins } from "../models/campers";
import { resetUserPhotosNotice } from "../models/userCampState";
import { syncParentWelcomes, syncWelcomes, welcomePreview } from "../services/notify";
import { evictStaffOutsideWindow, publish, rearmWindows, scheduleCheckinReminder } from "../services/realtime";
import { listEvents } from "../models/schedule";
import { parentWindowOf, parentWindowOpen } from "../services/camp";
import { coreClient } from "../services/ipalpha";
import type { MessageTemplate } from "../services/ipalpha/coreClient";
import { TEMPLATE_DEFAULTS, templateDefault, validateTemplate, type TemplateDefault } from "../messages/templates";
import { type BusHelperList, type CheckinLocation, type CheckinWindow, type NotificationSettings, type ParentContact, type Settings } from "../types";

type Env = { Variables: AuthVariables };

const settings = new Hono<Env>();

const RADIUS_MIN = 50;
const RADIUS_MAX = 5000;

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

function serializeWindow(w: CheckinWindow, open: boolean) {
  return {
    from: w.from?.toISOString() ?? null,
    until: w.until?.toISOString() ?? null,
    /** read-only: is the window open right now (server clock)? */
    open,
  };
}

/**
 * Async because the PARENTS' window (when they see the team's contacts) is
 * derived from the programme: check-in start → end of the last event.
 */
export async function serializeSettings(s: Settings) {
  const pw = parentWindowOf(s, await listEvents());
  return {
    checkinLocations: s.checkinLocations.map((l) => ({ ...l })),
    /** read-only: when parents see the team's contacts (from the check-in start to the end of the last event) */
    parentWindow: serializeWindow(pw, parentWindowOpen(pw)),
    notifications: s.notifications,
    checkinWindow: serializeWindow(s.checkinWindow, s.checkinTestMode || checkinWindowOpen(s.checkinWindow)),
    busReturnWindow: serializeWindow(s.busReturnWindow, s.checkinTestMode || checkinWindowOpen(s.busReturnWindow)),
    checkinTestMode: s.checkinTestMode,
    kidsRoomsDraft: s.kidsRoomsDraft,
    scoreDraft: s.scoreDraft,
    /** the suspense window: written through PUT /api/scores/suspense (game organizers too) */
    scoreHideWindow: serializeWindow(s.scoreHideWindow, scoreHidden(s.scoreHideWindow)),
    wizardMode: s.wizardMode,
    galleryPublished: s.galleryPublished,
    staffAccessWindow: serializeWindow(s.staffAccessWindow, staffAccessOpen(s.staffAccessWindow)),
    parentAccessWindow: serializeWindow(s.parentAccessWindow, staffAccessOpen(s.parentAccessWindow)),
    checkinReminder: { at: s.checkinReminder.at?.toISOString() ?? null, sentAt: s.checkinReminder.sentAt?.toISOString() ?? null },
    /** the vehicle each `checkin-onibus` person stands at (the role itself lives in projects-api) */
    busHelpers: { helpers: s.busHelpers.helpers.map((h) => ({ personId: h.personId, vehicleId: h.vehicleId })) },
    parentContacts: s.parentContacts.map((contact) => ({ ...contact })),
    /**
     * Staff who scanned ≥3 kids outside their scope (emergency QR). Always an
     * empty list for non-managers; empty for managers too when nobody reached
     * the threshold — the Geral card stays hidden then.
     */
    foreignLookupOffenders: [] as { personId: string; count: number; camperIds: string[]; blocked: boolean }[],
    updatedAt: s.updatedAt,
  };
}

/** Same as serializeSettings, plus the offenders list (managers) and the super-admin flag. Names are read by the client (POST /api/people/names). */
export async function serializeSettingsForManager(s: Awaited<ReturnType<typeof getSettings>>, superAdmin = false) {
  const base = await serializeSettings(s);
  return {
    ...base,
    /** read-only: this session is a deployment owner (SUPER_ADMIN_PERSON_IDS) */
    superAdmin,
    foreignLookupOffenders: (await listForeignLookupOffenders(FOREIGN_LOOKUP_ALERT_AT)).map((p) => ({
      personId: p._id,
      count: p.foreignLookupCount,
      camperIds: p.foreignLookupCamperIds,
      blocked: p.foreignLookupCount >= 5,
    })),
  };
}

function parseNotifications(value: unknown, current: NotificationSettings): NotificationSettings | { error: string } {
  if (!value || typeof value !== "object") return { error: "Informe as notificações." };
  const o = value as Record<string, unknown>;
  const out = { ...current };
  for (const k of ["bedroomChanges", "roleChanges", "checkinConfirmation", "contentChanges", "parentContentChanges", "staffChanges", "enrolments", "occurrences", "checkinReminder", "parentEdits", "busCheckin", "parentWelcome", "birthdays", "photoPublishes"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") return { error: "Cada notificação deve ser ligada ou desligada." };
    out[k] = o[k] as boolean;
  }
  return out;
}

/** `[{ id, name, lat, lng, radiusM }]` — at least one spot; ids unique (the client mints them). */
function parseLocations(value: unknown): CheckinLocation[] | { error: string } {
  if (!Array.isArray(value)) return { error: "Informe a lista de pontos de encontro." };
  if (value.length === 0) return { error: "Deixe pelo menos um ponto de encontro." };
  if (value.length > 20) return { error: "Pontos de encontro demais (máx. 20)." };
  const out: CheckinLocation[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { error: "Ponto de encontro inválido." };
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id || id.length > 80 || ids.has(id)) return { error: "Algum ponto de encontro tem um identificador inválido ou repetido." };
    ids.add(id);
    const name = typeof o.name === "string" ? o.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 60) return { error: "Dê um nome (até 60 caracteres) a cada ponto de encontro." };
    const lat = Number(o.lat);
    const lng = Number(o.lng);
    const radiusM = o.radiusM === undefined ? 300 : Number(o.radiusM);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: `${name}: latitude inválida (entre -90 e 90).` };
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: `${name}: longitude inválida (entre -180 e 180).` };
    if (!Number.isFinite(radiusM) || radiusM < RADIUS_MIN || radiusM > RADIUS_MAX) {
      return { error: `${name}: o raio precisa estar entre ${RADIUS_MIN} e ${RADIUS_MAX} metros.` };
    }
    out.push({ id, name, lat, lng, radiusM: Math.round(radiusM) });
  }
  return out;
}

/** { from: ISO | null, until: ISO | null } — from < until when both are set */
export function parseWindow(value: unknown): CheckinWindow | { error: string } {
  if (!value || typeof value !== "object") return { error: "Informe a janela do check-in." };
  const o = value as Record<string, unknown>;
  const parseDate = (v: unknown, label: string): Date | null | { error: string } => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "string") return { error: `${label} inválido.` };
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? { error: `${label} inválido.` } : d;
  };
  const from = parseDate(o.from, "Início da janela");
  if (from && "error" in from) return from;
  const until = parseDate(o.until, "Fim da janela");
  if (until && "error" in until) return until;
  if (from && until && from >= until) return { error: "O fim da janela precisa ser depois do início." };
  return { from, until };
}

/** { at: ISO | null } — the instant of the check-in reminder (null / "" = none) */
function parseReminderAt(value: unknown): Date | null | { error: string } {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const v = o ? o.at : value;
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return { error: "Data do lembrete inválida." };
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? { error: "Data do lembrete inválida." } : d;
}

/** [{ id, title, personId }] — ordered, unique entries pointing to active team members of this camp */
async function parseParentContacts(value: unknown): Promise<ParentContact[] | { error: string }> {
  if (!Array.isArray(value)) return { error: "A lista de contatos é inválida." };
  const contacts: ParentContact[] = [];
  for (const x of value) {
    const contact = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    if (!contact || typeof contact.id !== "string" || typeof contact.title !== "string" || typeof contact.personId !== "string") {
      return { error: "Cada contato precisa de um título e uma pessoa da equipe." };
    }
    const id = contact.id.trim();
    const title = contact.title.trim();
    const personId = contact.personId.trim();
    if (!id || id.length > 80) return { error: "Algum contato tem um identificador inválido." };
    if (!title || title.length > 80) return { error: "O título de cada contato deve ter entre 1 e 80 caracteres." };
    if (!personId) return { error: "Escolha uma pessoa da equipe para cada contato." };
    contacts.push({ id, title, personId });
  }
  if (new Set(contacts.map((contact) => contact.id)).size !== contacts.length) return { error: "Há contatos duplicados." };
  const active = new Set((await listStaff({ active: true })).map((staff) => staff._id));
  if (contacts.some((contact) => !active.has(contact.personId))) return { error: "Alguma pessoa não existe ou está inativa na equipe." };
  return contacts;
}

/** { helpers: [{ personId, vehicleId }] } — one vehicle per person, an existing Transport. The `checkin-onibus` ROLE comes from projects-api. */
async function parseBusHelpers(value: unknown): Promise<BusHelperList | { error: string }> {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const raw = o ? o.helpers : undefined;
  if (!Array.isArray(raw)) return { error: "A lista de ajudantes do ônibus é inválida." };
  const helpers: BusHelperList["helpers"] = [];
  for (const x of raw) {
    const h = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    if (!h || typeof h.personId !== "string" || typeof h.vehicleId !== "string") return { error: "Cada ajudante do ônibus precisa de uma pessoa e um veículo." };
    helpers.push({ personId: h.personId, vehicleId: h.vehicleId });
  }
  if (new Set(helpers.map((h) => h.personId)).size !== helpers.length) return { error: "Cada pessoa só pode ficar na porta de um veículo." };
  const vehicles = new Set((await listTransports()).map((v) => v._id));
  if (helpers.some((h) => !vehicles.has(h.vehicleId))) return { error: "Algum veículo não existe." };
  return { helpers };
}

settings.use("*", requireAuth);

/** GET /api/settings — any logged-in role (the team needs the check-in spot to know how far they are). */
settings.get("/", async (c) => c.json({ settings: await serializeSettings(await getSettings()) }));

/**
 * PUT /api/settings — coordenação or organização (`notifications` is the
 * coordenação's). { checkinLocations?, notifications?, checkinWindow?,
 * busReturnWindow?, staffAccessWindow?, parentAccessWindow?, checkinReminder?,
 * busHelpers?: { helpers: [{ personId, vehicleId }] }, parentContacts?: [{ id,
 * title, personId }], … }. WHO holds each helper role is managed in
 * projects-api (Mordomia); the windows stay here.
 */
settings.put("/", requireManager, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  // an organizer never edits the organizers list nor the SMS switches (except the check-in reminder toggle, which lives on Geral)
  if (c.get("activeRole") !== "admin") {
    const n = body.notifications;
    const onlyReminder = n === undefined || (typeof n === "object" && n !== null && Object.keys(n).every((k) => k === "checkinReminder"));
    if (!onlyReminder) {
      return c.json({ error: { code: "FORBIDDEN", message: "Só a coordenação altera as notificações." } }, 403);
    }
  }

  const patch: Partial<Omit<Settings, "updatedAt">> = {};
  if (body.checkinLocations !== undefined) {
    const locs = parseLocations(body.checkinLocations);
    if (!Array.isArray(locs)) return fail(c, "LOCATION_INVALID", locs.error);
    patch.checkinLocations = locs;
  }
  if (body.notifications !== undefined) {
    const n = parseNotifications(body.notifications, (await getSettings()).notifications);
    if ("error" in n) return fail(c, "NOTIFICATIONS_INVALID", n.error);
    patch.notifications = n;
  }
  let windowChanged = false;
  if (body.busHelpers !== undefined) {
    const l = await parseBusHelpers(body.busHelpers);
    if ("error" in l) return fail(c, "HELPERS_INVALID", l.error);
    patch.busHelpers = l;
  }
  if (body.parentContacts !== undefined) {
    const contacts = await parseParentContacts(body.parentContacts);
    if (!Array.isArray(contacts)) return fail(c, "CONTACTS_INVALID", contacts.error);
    patch.parentContacts = contacts;
  }
  if (body.checkinWindow !== undefined) {
    const w = parseWindow(body.checkinWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.checkinWindow = w;
    windowChanged = true;
  }
  if (body.busReturnWindow !== undefined) {
    const w = parseWindow(body.busReturnWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.busReturnWindow = w;
    windowChanged = true;
  }
  if (body.staffAccessWindow !== undefined) {
    const w = parseWindow(body.staffAccessWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.staffAccessWindow = w;
    windowChanged = true;
  }
  if (body.parentAccessWindow !== undefined) {
    const w = parseWindow(body.parentAccessWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.parentAccessWindow = w;
    windowChanged = true;
  }
  if (body.checkinTestMode !== undefined) {
    if (typeof body.checkinTestMode !== "boolean") return fail(c, "TEST_MODE_INVALID", "O modo de teste deve ser ligado ou desligado.");
    patch.checkinTestMode = body.checkinTestMode;
    windowChanged = true;
  }
  let reminderChanged = false;
  if (body.checkinReminder !== undefined) {
    const at = parseReminderAt(body.checkinReminder);
    if (at && "error" in at) return fail(c, "REMINDER_INVALID", at.error);
    const current = (await getSettings()).checkinReminder;
    // same instant → keep the "already sent" mark; a new instant re-arms the reminder
    const same = (at?.getTime() ?? null) === (current.at?.getTime() ?? null);
    patch.checkinReminder = { at, sentAt: same ? current.sentAt : null };
    reminderChanged = true;
  }
  let draftChanged = false;
  if (body.kidsRoomsDraft !== undefined) {
    if (typeof body.kidsRoomsDraft !== "boolean") return fail(c, "DRAFT_INVALID", "O rascunho dos quartos deve ser ligado ou desligado.");
    patch.kidsRoomsDraft = body.kidsRoomsDraft;
    draftChanged = true;
  }
  if (body.galleryPublished !== undefined) {
    if (typeof body.galleryPublished !== "boolean") return fail(c, "PUBLISHED_INVALID", "A publicação das fotos deve ser ligada ou desligada.");
    patch.galleryPublished = body.galleryPublished;
  }

  if (body.scoreDraft !== undefined) {
    if (typeof body.scoreDraft !== "boolean") return fail(c, "SCORE_DRAFT_INVALID", "O rascunho do placar deve ser ligado ou desligado.");
    patch.scoreDraft = body.scoreDraft;
  }
  if (body.wizardMode !== undefined) {
    if (typeof body.wizardMode !== "boolean") return fail(c, "WIZARD_MODE_INVALID", "O modo assistente deve ser ligado ou desligado.");
    const isSuper = c.get("user").superAdmin;
    // only the deployment owner turns the lock ON; any admin may turn it OFF (finish / leave the wizard)
    if (body.wizardMode === true && !isSuper) {
      return c.json({ error: { code: "FORBIDDEN", message: "Só o administrador da implantação liga o assistente." } }, 403);
    }
    patch.wizardMode = body.wizardMode;
  }
  if (Object.keys(patch).length === 0) return fail(c, "NOTHING_TO_UPDATE", "Nada para atualizar.");

  const previous = await getSettings();
  const updated = await updateSettings(patch);
  const scopeChanged = patch.busHelpers || patch.parentContacts || windowChanged || draftChanged;
  if (scopeChanged) {
    // Any access-list change may alter which records a phone is allowed to keep.
    // Re-send every scoped collection so gains and revocations happen live.
    publish("campers", "staff", "bedrooms", "roles", "events", "occurrences", "medications", "scores", "gallery");
    // someone may have just left every list while the team window is closed: log them out now
    if (!windowChanged) void evictStaffOutsideWindow().catch((err) => console.error("realtime: evict failed", err));
  }
  // Settings are shared application data too: every connected admin/team
  // client receives the canonical value through the WebSocket collection.
  publish("settings");
  // the date or the toggle changed: re-arm (a pending past instant with the toggle now on fires at once)
  if (reminderChanged || patch.notifications) scheduleCheckinReminder(updated.checkinReminder.at);
  // the album notice is a ONCE-PER-CAMP SMS: turning it back ON re-arms it for everybody
  if (patch.notifications?.photoPublishes && !previous.notifications.photoPublishes) {
    const [staff, parents] = await Promise.all([resetStaffPhotosNotice(), resetUserPhotosNotice()]);
    if (staff + parents > 0) console.log(`🧹 album notice re-armed: ${staff} staff, ${parents} parents`);
  }
  // a welcome toggle switched ON: whoever is inside their window and was never welcomed gets the SMS now
  if (patch.notifications?.enrolments && !previous.notifications.enrolments) void syncWelcomes();
  if (patch.notifications?.parentWelcome && !previous.notifications.parentWelcome) void syncParentWelcomes();
  if (windowChanged) {
    void rearmWindows();
    if (patch.staffAccessWindow) void syncWelcomes(); // the window may have just opened (start moved to the past)
    if (patch.parentAccessWindow) void syncParentWelcomes();
    // the admin may have closed the team's window right now: log those people out
    void evictStaffOutsideWindow().catch((err) => console.error("realtime: evict failed", err));
  }
  return c.json({ settings: await serializeSettingsForManager(updated, c.get("user").superAdmin) });
});

/** GET /api/settings/welcome-preview — coordenação. Who would get the welcome RIGHT NOW (person ids; names via /api/people/names). */
settings.get("/welcome-preview", requireAdmin, async (c) => c.json(await welcomePreview()));

// ── message templates (projects-api `projects:templates`, CONTRACTS §11/§15) ──

type TemplatePatch = Partial<Pick<MessageTemplate, "name" | "body" | "subject">>;

function serializeTemplate(def: TemplateDefault | null, live: MessageTemplate | null) {
  const src = live ?? def!;
  return {
    slug: src.slug,
    name: src.name,
    channel: src.channel,
    variables: def?.variables ?? live?.variables ?? [],
    subject: src.subject ?? null,
    body: src.body,
    /** created in the project (else only the default copy exists) */
    live: !!live,
    version: live?.version ?? null,
    /** the live copy differs from Acampa's default */
    customized: !!live && !!def && (JSON.stringify(live.body) !== JSON.stringify(def.body) || JSON.stringify(live.subject ?? null) !== JSON.stringify(def.subject ?? null)),
    /** pt-BR default, for "restaurar" */
    defaults: def ? { body: def.body, subject: def.subject ?? null } : null,
  };
}

/** GET /api/settings/message-templates — the coordenação. Every Acampa template: live copy (projects-api) + default. */
settings.get("/message-templates", requireAdmin, async (c) => {
  const live = await coreClient().listTemplates();
  const bySlug = new Map(live.map((t) => [t.slug, t]));
  const known = TEMPLATE_DEFAULTS.map((d) => serializeTemplate(d, bySlug.get(d.slug) ?? null));
  const extra = live.filter((t) => !templateDefault(t.slug)).map((t) => serializeTemplate(null, t));
  return c.json({ templates: [...known, ...extra] });
});

/** POST /api/settings/message-templates/seed — creates every catalog template the project does not have yet. */
settings.post("/message-templates/seed", requireAdmin, async (c) => {
  const live = new Set((await coreClient().listTemplates()).map((t) => t.slug));
  let created = 0;
  for (const d of TEMPLATE_DEFAULTS) {
    if (live.has(d.slug)) continue;
    await coreClient().createTemplate({ slug: d.slug, name: d.name, channel: d.channel, ...(d.subject ? { subject: d.subject } : {}), body: d.body, variables: d.variables });
    created++;
  }
  return c.json({ created, total: TEMPLATE_DEFAULTS.length });
});

/**
 * PATCH /api/settings/message-templates/:slug { name?, body?, subject? } —
 * edits the project's copy (variables are fixed by Acampa's code). Validated
 * here with core's rules (pt-BR required, known `{vars}`, SMS ≤ 320 chars);
 * a template not created yet is created from the default + the edit.
 */
settings.patch("/message-templates/:slug", requireAdmin, async (c) => {
  const slug = c.req.param("slug");
  const def = templateDefault(slug);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const text = (v: unknown): Record<string, string> | undefined =>
    v && typeof v === "object" ? (Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>) : undefined;
  const patch: TemplatePatch = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
  if (body.body !== undefined) patch.body = text(body.body);
  if (body.subject !== undefined) patch.subject = text(body.subject);
  const current = await coreClient().getTemplate(slug);
  if (!current && !def) return fail(c, "TEMPLATE_NOT_FOUND", "Modelo não encontrado.", 404);
  const base = current ?? { slug, name: def!.name, channel: def!.channel, subject: def!.subject, body: def!.body, variables: def!.variables };
  const merged = { ...base, ...patch, variables: def?.variables ?? base.variables };
  const invalid = validateTemplate({ slug, channel: merged.channel, body: merged.body as never, subject: merged.subject as never, variables: merged.variables });
  if (invalid) return fail(c, "TEMPLATE_INVALID", `Modelo inválido: ${invalid}.`);
  const saved = current
    ? await coreClient().updateTemplate(slug, patch)
    : await coreClient().createTemplate({ slug, name: merged.name, channel: merged.channel, ...(merged.subject ? { subject: merged.subject } : {}), body: merged.body, variables: merged.variables });
  return c.json({ template: serializeTemplate(def, saved) });
});

/** POST /api/settings/message-templates/:slug/reset — back to Acampa's default copy. */
settings.post("/message-templates/:slug/reset", requireAdmin, async (c) => {
  const def = templateDefault(c.req.param("slug"));
  if (!def) return fail(c, "TEMPLATE_NOT_FOUND", "Modelo não encontrado.", 404);
  const current = await coreClient().getTemplate(def.slug);
  const saved = current
    ? await coreClient().updateTemplate(def.slug, { name: def.name, body: def.body, ...(def.subject ? { subject: def.subject } : {}) })
    : await coreClient().createTemplate({ slug: def.slug, name: def.name, channel: def.channel, ...(def.subject ? { subject: def.subject } : {}), body: def.body, variables: def.variables });
  return c.json({ template: serializeTemplate(def, saved) });
});

/** POST /api/settings/checkin/reset — admin only. Clears EVERY check-in (kids' church + both bus trips, team), the team vests and the audit log, so the process can be rehearsed. */
settings.post("/checkin/reset", requireManager, async (c) => {
  const [campers, staff, vests] = await Promise.all([resetCamperCheckins(), resetStaffCheckins(), resetStaffVests()]);
  await clearCheckinLog();
  console.log(`🧹 check-ins reset: ${campers} campers, ${staff} staff, ${vests} vests`);
  publish("campers", "staff");
  return c.json({ campers, staff, vests });
});

/**
 * POST /api/settings/foreign-lookups/reset — admin / organizer. Zeroes every
 * staff member's out-of-scope emergency-QR counter (and unblocks anyone at ≥5).
 * The scan log itself is kept for audit.
 */
settings.post("/foreign-lookups/reset", requireManager, async (c) => {
  const staff = await resetForeignLookups();
  console.log(`🧹 foreign lookups reset: ${staff} staff`);
  publish("staff", "settings");
  return c.json({ staff, settings: await serializeSettingsForManager(await getSettings(), c.get("user").superAdmin) });
});

export default settings;
