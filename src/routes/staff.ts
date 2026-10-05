import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { publish } from "../services/realtime";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireManager, requireRole } from "../middleware/roles";
import { countStaffPerBedroom, findBedroomById } from "../models/bedrooms";
import { countCampersPerBedroom } from "../models/campers";
import { listCampers, reassignCampers, setCaretakerOf, updateCamper } from "../models/campers";
import { listEvents, listRoles, unassignStaffEverywhere } from "../models/schedule";
import { serializeCamperList } from "./campers";
import { deleteStaff, EMPTY_STAFF, findStaffById, insertStaff, listStaff, NO_VEST, setStaffCheckin, setStaffPrepDone, setStaffVest, updateStaff, type StaffData } from "../models/staff";
import { participantKind } from "../models/participants";
import { logCheckin } from "../models/campers";
import { bedroomCapacity, ROOM_ROLES, TEAM_ROLE, type RoomRole, type SessionUser, type Staff } from "../types";
import { canHandleVests, hideOwnBedroom, resolveScope, staffVisibility, type Scope } from "../services/scope";
import { bedroomFullMessage, isInvalid, parseBedroom, parseTeam, parseText, parseTransport } from "./_validate";
import { listTeams } from "../models/teams";
import { assignmentDetail, autoRoleFor, dutyOf, teamMap } from "../services/schedule";
import { distanceMeters, normalizeBrazilPhone, titleCaseName, nowInSaoPauloWallClock, saoPauloWallClock, saoPauloWallClockToIso, todayInSaoPaulo } from "../utils";
import { getSettings } from "../models/settings";
import { notifyCaretakerChange, notifyCheckin, notifyStaffChange, syncWelcomes } from "../services/notify";
import { actingToken, campEditionId, coordinationToken } from "../services/acting";
import { coreClient } from "../services/ipalpha";
import { PERSONS_RESOURCE, PROJECTS_RESOURCE } from "../services/ipalpha/coreClient";
import { hasHealthInfo, nameMatches, namesOf, pageOf, readHealth, readHealthMany } from "../services/people";
import { registrationData, registrationExtras, registrationProfile } from "../services/coreRegistration";

type Env = { Variables: AuthVariables };

const staff = new Hono<Env>();

const NAME_MAX = 80;
const TEXT_MAX = 500;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 | 409 | 502 = 400) {
  return c.json({ error: { code, message } }, status);
}

/** Full record — admin only (or the person themself). */
export function serializeStaff(s: Staff) {
  return serialize(s);
}

/**
 * The team member's camp-ops record per the viewer's scope, or null when
 * invisible. A CONTACT view (roommate, a parent's contact, the vest helper)
 * keeps only the room role, the room when the viewer may know it and — for
 * the vest helper — the vest. Phones are never here: a contact is reached
 * through core (the app shows the name; contacts come from persons-api with
 * the acting role token).
 */
export function serializeStaffFor(s: Staff, scope: Scope) {
  const vis = staffVisibility(scope, s);
  if (vis === "none") return null;
  const full = serialize(s);
  if (vis === "full") return hideOwnBedroom(scope) ? { ...full, bedroom: null } : full;
  const roommate = !scope.all && !scope.kidsRoomsDraft && scope.bedroom !== null && s.bedroom === scope.bedroom;
  const parentRoom = !scope.all && scope.parentKids.length > 0 && s.bedroom !== null && scope.parentBedrooms.includes(s.bedroom);
  return {
    ...full,
    redacted: true,
    team: roommate ? s.team : null,
    bedroom: roommate || parentRoom ? s.bedroom : null,
    transportation: null,
    generalNotes: "",
    checkin: null,
    vest: !scope.all && scope.vestHelper ? s.vest : NO_VEST,
    prepDone: [],
    foreignLookupCount: 0,
    foreignLookupCamperIds: [],
    aiReviewStatus: null,
    aiReviewError: "",
  };
}

/** Every member the viewer may see (already serialized per their scope). */
export function serializeStaffList(list: Staff[], scope: Scope) {
  return list.map((s) => serializeStaffFor(s, scope)).filter((x): x is NonNullable<typeof x> => x !== null);
}

async function setStaffBedroom(id: string, bedroom: string | null, extra: Partial<StaffData>) {
  return updateStaff(id, { ...extra, bedroom });
}

function serialize(s: Staff) {
  return {
    id: s._id,
    personId: s.personId,
    active: s.active,
    team: s.team,
    bedroom: s.bedroom,
    roomRole: s.roomRole,
    transportation: s.transportation,
    generalNotes: s.generalNotes,
    aiReviewStatus: s.aiReviewStatus ?? null,
    aiReviewError: s.aiReviewError ?? "",
    aiReviewStartedAt: s.aiReviewStartedAt ?? null,
    aiReviewFinishedAt: s.aiReviewFinishedAt ?? null,
    checkin: s.checkin,
    vest: s.vest,
    prepDone: s.prepDone,
    /** out-of-scope emergency QR lookups (person ids of the kids) */
    foreignLookupCount: s.foreignLookupCount,
    foreignLookupCamperIds: s.foreignLookupCamperIds,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Validated camp-ops patch (only keys present in the body). */
async function buildPatch(body: Record<string, unknown>): Promise<{ patch: Partial<StaffData> } | { code: string; message: string; status?: 400 | 409 }> {
  const patch: Partial<StaffData> = {};
  const has = (k: string) => body[k] !== undefined;
  if (has("active")) {
    if (typeof body.active !== "boolean") return { code: "ACTIVE_INVALID", message: "Ativo deve ser sim ou não." };
    patch.active = body.active;
  }
  if (has("team")) {
    const v = await parseTeam(body.team);
    if (isInvalid(v)) return { code: "TEAM_INVALID", message: v.error };
    patch.team = v;
  }
  if (has("transportation")) {
    const v = await parseTransport(body.transportation);
    if (isInvalid(v)) return { code: "TRANSPORTATION_INVALID", message: v.error };
    patch.transportation = v;
  }
  if (has("bedroom")) {
    const v = await parseBedroom(body.bedroom);
    if (isInvalid(v)) return { code: "BEDROOM_INVALID", message: v.error };
    patch.bedroom = v;
  }
  if (has("roomRole")) {
    if (!ROOM_ROLES.includes(body.roomRole as RoomRole)) return { code: "ROOM_ROLE_INVALID", message: "Função no quarto deve ser líder ou auxiliar." };
    patch.roomRole = body.roomRole as RoomRole;
  }
  if (has("generalNotes")) {
    const v = parseText(body.generalNotes, TEXT_MAX);
    if (isInvalid(v)) return { code: "GENERALNOTES_INVALID", message: v.error };
    patch.generalNotes = v;
  }
  return { patch };
}

staff.use("*", requireAuth);

// ── read: admin sees everyone; staff/health staff only their own room (see services/scope.ts) ──

/**
 * GET /api/staff?active=&cursor&limit&q — one PAGE of the team members the
 * viewer may see (camp ops + live `name` / `nickname` for the page, + the
 * neutral `hasHealth` for roles allowed health). `{items, nextCursor, total}`.
 */
staff.get("/", requireRole("admin", "staff", "parent"), async (c) => {
  const q = c.req.query("active");
  const active = q === "true" ? true : q === "false" ? false : undefined;
  const nameQ = (c.req.query("q") ?? "").trim();
  const [list, scope] = await Promise.all([listStaff({ active }), resolveScope(c.get("user"))]);
  let visible = list.filter((s) => staffVisibility(scope, s) !== "none");
  let names = new Map<string, { name: string; nickname: string | null; sex: "F" | "M" | null }>();
  if (nameQ) {
    names = await namesOf(visible.map((s) => s._id));
    visible = visible.filter((s) => nameMatches(names.get(s._id)?.name ?? "", nameQ) || nameMatches(names.get(s._id)?.nickname ?? "", nameQ));
  }
  const page = pageOf(visible, c.req.query("cursor"), Number(c.req.query("limit") ?? 50));
  const missing = page.items.filter((s) => !names.has(s._id)).map((s) => s._id);
  if (missing.length) for (const [id, n] of await namesOf(missing)) names.set(id, n);
  const mayHealth = scope.all || scope.organizer;
  const health = mayHealth ? await readHealthMany(actingToken(c, PERSONS_RESOURCE), page.items.map((s) => s._id)) : new Map();
  const items = page.items.map((s) => ({
    ...serializeStaffFor(s, scope)!,
    name: names.get(s._id)?.name ?? "",
    nickname: names.get(s._id)?.nickname ?? null,
    sex: names.get(s._id)?.sex ?? null,
    ...(mayHealth ? { hasHealth: health.has(s._id) ? hasHealthInfo(health.get(s._id)) : false } : {}),
  }));
  return c.json({ items, nextCursor: page.nextCursor, total: visible.length });
});

/** GET /api/staff/:id — the member's page (camp ops + name; health for the person themself / managers, via the acting token). */
staff.get("/:id", requireRole("admin", "staff", "parent"), async (c) => {
  const s = await findStaffById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  const out = s ? serializeStaffFor(s, scope) : null;
  if (!s || !out) return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
  const name = (await namesOf([s._id])).get(s._id);
  const withHealth = staffVisibility(scope, s) === "full";
  return c.json({ staff: { ...out, name: name?.name ?? "", nickname: name?.nickname ?? null, sex: name?.sex ?? null, ...(withHealth ? { health: await readHealth(actingToken(c, PERSONS_RESOURCE), s._id) } : {}) } });
});

/**
 * GET /api/staff/:id/detail — the person + their schedule (every event they
 * are assigned to, with the role) + the campers in their bedroom (the kids
 * they are responsible for) + the other staff sharing the room.
 */
staff.get("/:id/detail", requireRole("admin", "staff"), async (c) => {
  const s = await findStaffById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  // the full detail (schedule, kids) is only for the admin or the person themself
  if (!s || staffVisibility(scope, s) !== "full") return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
  // draft rooms: no bedroom, kids or roommates for the person themself
  const roomId = hideOwnBedroom(scope) ? null : s.bedroom;

  const [events, roles, bedroom, allStaff, teams] = await Promise.all([
    listEvents(),
    listRoles(),
    roomId ? findBedroomById(roomId) : null,
    roomId ? listStaff() : [],
    listTeams(),
  ]);
  const roleById = new Map(roles.map((r) => [r._id, r]));
  const teamById = teamMap(teams);

  const schedule = events
    .map((e) => {
      // explicit escala wins; otherwise the função that falls on the person's POSITION (active members only)
      const duty = dutyOf(e, s, roleById);
      if (!duty) return null;
      const { role: r, assignment: a } = duty;
      /** what they'd fall back to here if the escala were removed (their position's função, if any) */
      const fallback = s.active ? autoRoleFor(e, s.roomRole, roleById) : undefined;
      return {
        eventId: e._id,
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        title: e.title,
        emoji: e.emoji,
        role: r ? { id: r._id, name: r.name, emoji: r.emoji, instructions: r.instructions } : null,
        ...assignmentDetail(r, a, s, teamById),
        /** true when the função came from the person's POSITION rather than an explicit escala */
        implicit: !a,
        defaultRole: fallback ? { id: fallback._id, name: fallback.name, emoji: fallback.emoji } : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const campers = roomId ? await listCampers({ bedroom: roomId }) : [];
  const roommates = roomId ? allStaff.filter((x) => x.bedroom === roomId && x._id !== s._id) : [];

  return c.json({
    staff: roomId === s.bedroom ? serialize(s) : { ...serialize(s), bedroom: null },
    bedroom: bedroom ? { id: bedroom._id, name: bedroom.name, group: bedroom.group } : null,
    schedule,
    campers: serializeCamperList(campers, scope),
    roommates: serializeStaffList(roommates, scope),
  });
});

// ── self check-in: a team member marks their OWN arrival ────────────────────

/**
 * The rule, so the phone can't lie about it: it must be the departure day
 * (the day of the FIRST event of the programme), the window opens
 * `SELF_CHECKIN_OPENS_MINUTES_BEFORE` before that event starts, and the
 * device must be at ONE of the meeting points (`settings.checkinLocations`:
 * the church, the camp site…) — within that spot's radius; the nearest spot
 * wins and is recorded in the stamp. All checks run here, never
 * trusted from the client. Times are compared in São Paulo wall-clock.
 */
export type SelfCheckinBlock = "NOT_LINKED" | "INACTIVE" | "NO_SCHEDULE" | "NOT_TODAY" | "NOT_YET" | "ALREADY_CHECKED_IN";

const SELF_CHECKIN_OPENS_MINUTES_BEFORE = 60;

interface SelfCheckinWindow {
  /** departure day "YYYY-MM-DD" (null when there is no programme) */
  date: string | null;
  /** ISO instant from which the check-in is accepted (null when there is no programme) */
  opensAt: string | null;
}

async function selfCheckinGate(user: SessionUser): Promise<({ ok: true; me: Staff } | { ok: false; code: SelfCheckinBlock; message: string }) & SelfCheckinWindow> {
  const [me, events] = await Promise.all([findStaffById(user.personId), listEvents()]);
  const first = events[0] ?? null; // listEvents() sorts by (date, startTime)
  const date = first?.date ?? null;
  const opensWall = first ? saoPauloWallClock(first.date, first.startTime) - SELF_CHECKIN_OPENS_MINUTES_BEFORE * 60_000 : null;
  const window: SelfCheckinWindow = { date, opensAt: opensWall === null ? null : saoPauloWallClockToIso(opensWall) };
  if (!me) return { ok: false, code: "NOT_LINKED", message: "Você não está na equipe deste acampamento.", ...window };
  if (!me.active) return { ok: false, code: "INACTIVE", message: "Seu cadastro na equipe está inativo.", ...window };
  if (!first || opensWall === null) return { ok: false, code: "NO_SCHEDULE", message: "A programação ainda não foi cadastrada.", ...window };
  if (todayInSaoPaulo() !== first.date) return { ok: false, code: "NOT_TODAY", message: "O check-in só abre no dia da saída.", ...window };
  if (nowInSaoPauloWallClock() < opensWall) {
    const hh = new Date(opensWall).toISOString().slice(11, 16); // wall-clock laid over UTC → HH:mm as-is
    return { ok: false, code: "NOT_YET", message: `O check-in abre às ${hh.replace(":", "h")}, uma hora antes da saída.`, ...window };
  }
  if (me.checkin) return { ok: false, code: "ALREADY_CHECKED_IN", message: "Você já fez check-in.", ...window };
  return { ok: true, me, ...window };
}

/**
 * GET /api/staff/me/checkin — can I check myself in right now? Returns the
 * status + the target spot so the phone can show "você está a 120 m", and
 * `opensAt` so it can re-ask when the window opens.
 */
staff.get("/me/checkin", requireRole("staff", "admin"), async (c) => {
  const [gate, settings] = await Promise.all([selfCheckinGate(c.get("user")), getSettings()]);
  return c.json({
    allowed: gate.ok,
    reason: gate.ok ? null : { code: gate.code, message: gate.message },
    date: gate.date,
    opensAt: gate.opensAt,
    locations: settings.checkinLocations,
    staff: gate.ok ? serialize(gate.me) : null,
  });
});

/** POST /api/staff/me/checkin  { lat, lng, accuracyM? } — marks the logged-in member as arrived. */
staff.post("/me/checkin", requireRole("staff", "admin"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  const accuracyM = Number.isFinite(Number(body?.accuracyM)) ? Math.max(0, Number(body?.accuracyM)) : 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return fail(c, "LOCATION_REQUIRED", "Não foi possível ler a sua localização. Ative o GPS e tente de novo.");
  }

  const gate = await selfCheckinGate(user);
  if (!gate.ok) return fail(c, gate.code, gate.message, gate.code === "ALREADY_CHECKED_IN" ? 409 : 400);

  const { checkinLocations } = await getSettings();
  // the nearest meeting point; give the benefit of the GPS error margin (capped, so a 5 km "accuracy" can't be abused)
  const slack = Math.min(accuracyM, 200);
  const ranked = checkinLocations.map((spot) => ({ spot, distance: Math.round(distanceMeters({ lat, lng }, spot)) })).sort((a, b) => a.distance - b.distance);
  const nearest = ranked[0];
  const hit = ranked.find((r) => r.distance <= r.spot.radiusM + slack);
  if (!hit) {
    return c.json(
      { error: { code: "TOO_FAR", message: `Você está a ${fmtDistance(nearest.distance)} de ${nearest.spot.name}. Chegue mais perto para fazer o check-in.`, distanceM: nearest.distance, locationId: nearest.spot.id } },
      400,
    );
  }

  const stamp = { at: new Date(), byPersonId: user.id, byRole: user.coreRole };
  const updated = await setStaffCheckin(gate.me._id, stamp);
  await logCheckin({ who: "staff", personId: gate.me._id, kind: "church", action: "checkin", ...stamp, note: hit.spot.name });
  publish("staff");
  void notifyCheckin(updated!); // fire-and-forget: the SMS never delays or fails the check-in
  return c.json({ staff: serialize(updated!), distanceM: hit.distance, location: hit.spot });
});

/**
 * PUT /api/staff/me/prep/:key  { done: boolean } — ticks / unticks one item of
 * the person's Preparação checklist. `key` is "section:<id>" or "role:<id>".
 */
staff.put("/me/prep/:key", requireRole("staff", "admin"), async (c) => {
  const key = c.req.param("key");
  if (!/^(section|role):[a-f0-9]{24}$/.test(key)) return fail(c, "KEY_INVALID", "Item inválido.");
  const body = await c.req.json<{ done?: unknown }>().catch(() => null);
  if (!body || typeof body.done !== "boolean") return fail(c, "BODY_INVALID", "Envie { done: true | false }.");
  const me = await findStaffById(c.get("user").personId);
  if (!me) return fail(c, "NOT_LINKED", "Você não está na equipe deste acampamento.", 404);
  const updated = await setStaffPrepDone(me._id, key, body.done);
  publish("staff");
  return c.json({ staff: serialize(updated!) });
});

function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${m} m`;
}

// ── check-in roll call: admin or organizer ─────

const canCheckin = requireManager;

/** Marks or unmarks the arrival of a team member, stamping who did it and writing the audit line. */
async function doCheckin(c: Context<Env>, action: "checkin" | "undo") {
  const existing = await findStaffById(c.req.param("id") ?? "");
  if (!existing) return fail(c, "STAFF_NOT_FOUND", "Pessoa não encontrada.", 404);
  if (action === "checkin" && existing.checkin) return fail(c, "ALREADY_CHECKED_IN", "Esta pessoa já fez check-in.", 409);
  if (action === "undo" && !existing.checkin) return fail(c, "NOT_CHECKED_IN", "Esta pessoa ainda não fez check-in.", 409);
  const user = c.get("user");
  const stamp = { at: new Date(), byPersonId: user.id, byRole: user.coreRole };
  const updated = await setStaffCheckin(existing._id, action === "checkin" ? stamp : null);
  await logCheckin({ who: "staff", personId: existing._id, kind: "church", action, ...stamp });
  publish("staff");
  if (action === "checkin") void notifyCheckin(updated!); // the person gets the same receipt when the admin marks them
  return c.json({ staff: serialize(updated!) });
}

/** POST /api/staff/:id/checkin — the person arrived. DELETE undoes. */
staff.post("/:id/checkin", canCheckin, (c) => doCheckin(c, "checkin"));
staff.delete("/:id/checkin", canCheckin, (c) => doCheckin(c, "undo"));

// ── vest (colete): admin or a listed vest helper hands it out / takes it back ──

const requireVestHandler = createMiddleware<Env>(async (c, next) => {
  if (!canHandleVests(await resolveScope(c.get("user")))) {
    return c.json({ error: { code: "FORBIDDEN", message: "Só quem cuida dos coletes pode registrar entrega e devolução." } }, 403);
  }
  await next();
});

type VestAction = "deliver" | "undo-deliver" | "return" | "undo-return";

async function doVest(c: Context<Env>, action: VestAction) {
  const existing = await findStaffById(c.req.param("id") ?? "");
  if (!existing) return fail(c, "STAFF_NOT_FOUND", "Pessoa não encontrada.", 404);
  const first = "Esta pessoa";
  const { delivered, returned } = existing.vest;
  const user = c.get("user");
  const stamp = { at: new Date(), byPersonId: user.id, byRole: user.coreRole };
  let next: Staff["vest"];
  switch (action) {
    case "deliver":
      if (delivered) return fail(c, "ALREADY_DELIVERED", `${first} já recebeu o colete.`, 409);
      next = { delivered: stamp, returned: null };
      break;
    case "undo-deliver":
      if (!delivered) return fail(c, "NOT_DELIVERED", `${first} ainda não recebeu o colete.`, 409);
      next = NO_VEST;
      break;
    case "return":
      if (!delivered) return fail(c, "NOT_DELIVERED", `${first} ainda não recebeu o colete.`, 409);
      if (returned) return fail(c, "ALREADY_RETURNED", `${first} já devolveu o colete.`, 409);
      next = { delivered, returned: stamp };
      break;
    case "undo-return":
      if (!returned) return fail(c, "NOT_RETURNED", `${first} ainda não devolveu o colete.`, 409);
      next = { delivered, returned: null };
      break;
  }
  const updated = await setStaffVest(existing._id, next);
  publish("staff");
  return c.json({ staff: serializeStaffFor(updated!, await resolveScope(user)) });
}

/** POST /api/staff/:id/vest/delivery — the person received the vest. DELETE undoes. */
staff.post("/:id/vest/delivery", requireRole("admin", "staff"), requireVestHandler, (c) => doVest(c, "deliver"));
staff.delete("/:id/vest/delivery", requireRole("admin", "staff"), requireVestHandler, (c) => doVest(c, "undo-deliver"));
/** POST /api/staff/:id/vest/return — the person handed the vest back. DELETE undoes. */
staff.post("/:id/vest/return", requireRole("admin", "staff"), requireVestHandler, (c) => doVest(c, "return"));
staff.delete("/:id/vest/return", requireRole("admin", "staff"), requireVestHandler, (c) => doVest(c, "undo-return"));

// ── write: admin or organizer ──────────────────────────────────────────────────────

staff.use("/*", requireManager);

/**
 * POST /api/staff/register { name, phone, sex?, homeChurch?, school?, emergencyContact?, ...camp ops } — a NEW team member
 * through core with the coordenação token: persons registration (adult, the optional person fields in it) +
 * `equipe` membership in the camp's edition, then the participant row.
 */
staff.post("/register", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const name = typeof body.name === "string" ? titleCaseName(body.name) : "";
  if (!name || name.length > NAME_MAX) return fail(c, "NAME_INVALID", `Informe um nome com até ${NAME_MAX} caracteres.`);
  const phone = typeof body.phone === "string" ? normalizeBrazilPhone(body.phone) : null;
  if (!phone) return fail(c, "PHONE_INVALID", "Informe um celular brasileiro válido com DDD: é por ele que a pessoa entra no app.");
  const result = await buildPatch(body);
  if (!("patch" in result)) return fail(c, result.code, result.message, result.status);
  const extras = registrationExtras(body);
  if (!extras.ok) return fail(c, extras.code, extras.message);
  const session = c.get("session");
  const personsToken = coordinationToken(session, PERSONS_RESOURCE);
  const projectsToken = coordinationToken(session, PROJECTS_RESOURCE);
  if (!personsToken || !projectsToken) return fail(c, "COORDINATION_REQUIRED", "Só a coordenação cadastra pessoas.", 403);
  const editionId = await campEditionId();
  if (!editionId) return fail(c, "EDITION_UNKNOWN", "A edição deste acampamento ainda não existe no IPAlpha.", 409);
  const full = await bedroomFullMessage(result.patch.bedroom ?? null, null);
  if (full) return fail(c, "BEDROOM_FULL", full, 409);
  const data = await registrationData(personsToken, extras.data, undefined);
  const reg = await coreClient().register(personsToken, { role: TEAM_ROLE, people: [{ name, phone, ...registrationProfile(extras), ...(data ? { data } : {}) }] });
  const person = reg.people[0];
  if (!person) return fail(c, "REGISTRATION_FAILED", "O IPAlpha não confirmou o cadastro.", 502);
  if (await participantKind(person.personId)) return fail(c, "ALREADY_IN_CAMP", "Esta pessoa já está neste acampamento.", 409);
  await coreClient().addMembership(projectsToken, { personId: person.personId, role: TEAM_ROLE, editionId });
  const created = await insertStaff(person.personId, { ...EMPTY_STAFF, ...result.patch });
  publish("staff", "bedrooms");
  void syncWelcomes();
  return c.json({ staff: { ...serialize(created), name }, created: person.created }, 201);
});

/** POST /api/staff { personId, ...camp ops } — an existing IPAlpha person joins this camp's team. */
staff.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const personId = typeof body.personId === "string" ? body.personId.trim() : "";
  if (!personId) return fail(c, "PERSON_REQUIRED", "Escolha a pessoa no IPAlpha.");
  if (await participantKind(personId)) return fail(c, "ALREADY_IN_CAMP", "Esta pessoa já está neste acampamento.", 409);
  const result = await buildPatch(body);
  if (!("patch" in result)) return fail(c, result.code, result.message, result.status);
  const full = await bedroomFullMessage(result.patch.bedroom ?? null, null);
  if (full) return fail(c, "BEDROOM_FULL", full, 409);
  const created = await insertStaff(personId, { ...EMPTY_STAFF, ...result.patch });
  publish("staff", "bedrooms");
  void syncWelcomes();
  return c.json({ staff: serialize(created) }, 201);
});

/** PUT /api/staff/:id — camp ops (active, room, room role, team, transport, notes). */
staff.put("/:id", async (c) => {
  const existing = await findStaffById(c.req.param("id"));
  if (!existing) return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = await buildPatch(body);
  if (!("patch" in result)) return fail(c, result.code, result.message, result.status);
  if (result.patch.bedroom !== undefined && result.patch.bedroom !== existing.bedroom) {
    const full = await bedroomFullMessage(result.patch.bedroom, existing.bedroom);
    if (full) return fail(c, "BEDROOM_FULL", full, 409);
  }
  const updated = await updateStaff(existing._id, result.patch);
  // left the room, or stopped being a caretaker there → their kids are orphans now
  const lostKids = (updated!.bedroom !== existing.bedroom || updated!.roomRole !== "caretaker") && existing.roomRole === "caretaker";
  const orphaned = lostKids ? await reassignCampers(existing._id, null) : 0;
  publish("staff", "bedrooms", ...(orphaned ? ["campers" as const] : []), ...(updated!.roomRole !== existing.roomRole ? ["instructions" as const, "preparation" as const] : []));
  if (!existing.active && updated!.active) void syncWelcomes();
  else if (updated!.active) void notifyStaffChange(existing, updated!);
  return c.json({ staff: serialize(updated!) });
});

/**
 * POST /api/staff/:id/move  { bedroom, kids, [swapWith | assignTo] }
 * Moves a CARETAKER to another room (`bedroom` null = no room), deciding
 * what happens to the kids under their care:
 *   kids: "orphan"  → the kids stay in the room without a caretaker
 *   kids: "bring"   → the kids move along (same room, same caretaker)
 *   kids: "assign"  → the kids stay and go to `assignTo` (a member of that
 *                     room — a helper is promoted to caretaker)
 *   kids: "swap"    → exchange rooms with `swapWith` (a caretaker of the
 *                     target room): each one's kids go to the other
 * Every branch keeps Camper.caretakerId pointing at a caretaker of the kid's
 * own room. Bed positions are cleared when kids change room.
 */
staff.post("/:id/move", async (c) => {
  const me = await findStaffById(c.req.param("id"));
  if (!me) return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const target = await parseBedroom(body.bedroom);
  if (isInvalid(target)) return fail(c, "BEDROOM_INVALID", target.error);
  const kids = body.kids;
  if (kids !== "orphan" && kids !== "bring" && kids !== "assign" && kids !== "swap") return fail(c, "KIDS_INVALID", "Diga o que fazer com as crianças.");
  if (target === me.bedroom && kids !== "assign") return fail(c, "SAME_ROOM", "A pessoa já está neste quarto.");

  const myKids = await listCampers({ caretakerId: me._id });
  const other = typeof body.swapWith === "string" ? await findStaffById(body.swapWith) : typeof body.assignTo === "string" ? await findStaffById(body.assignTo) : null;
  const touched = new Set<string>();

  if (kids === "swap") {
    if (!other || !target || other.bedroom !== target) return fail(c, "SWAP_INVALID", "Escolha alguém que durma no quarto de destino para trocar.", 409);
    const theirKids = await listCampers({ caretakerId: other._id });
    // capacities are unaffected (one person out, one in) — only the kids swap hands
    await setStaffBedroom(me._id, target, { roomRole: "caretaker" });
    await setStaffBedroom(other._id, me.bedroom, { roomRole: me.roomRole === "caretaker" ? "caretaker" : other.roomRole });
    // kids stay in their rooms and get the caretaker who arrived
    await setCaretakerOf(myKids.map((k) => k._id), other._id);
    await setCaretakerOf(theirKids.map((k) => k._id), me._id);
    for (const k of [...myKids, ...theirKids]) touched.add(k._id);
    void notifyCaretakerChange(myKids, me, other);
    void notifyCaretakerChange(theirKids, other, me);
  } else if (kids === "assign") {
    if (!other || other._id === me._id || other.bedroom !== me.bedroom) return fail(c, "ASSIGN_INVALID", "Escolha alguém do mesmo quarto para assumir as crianças.", 409);
    if (target !== me.bedroom) {
      const full = await bedroomFullMessage(target, me.bedroom);
      if (full) return fail(c, "BEDROOM_FULL", full, 409);
      await setStaffBedroom(me._id, target, {});
    }
    if (other.roomRole !== "caretaker") await updateStaff(other._id, { roomRole: "caretaker" });
    await reassignCampers(me._id, other._id);
    for (const k of myKids) touched.add(k._id);
    void notifyCaretakerChange(myKids, me, other);
  } else if (kids === "bring") {
    if (!target) return fail(c, "BEDROOM_INVALID", "Escolha o quarto de destino para levar as crianças.");
    const room = await findBedroomById(target);
    const [st, ca] = await Promise.all([countStaffPerBedroom(), countCampersPerBedroom()]);
    const occupied = (st.get(target) ?? 0) + (ca.get(target) ?? 0);
    if (room && occupied + 1 + myKids.length > bedroomCapacity(room)) return fail(c, "BEDROOM_FULL", `O quarto ${room.name} não tem lugar para esta pessoa e ${myKids.length} crianças.`, 409);
    await setStaffBedroom(me._id, target, { roomRole: "caretaker" });
    for (const k of myKids) {
      await updateCamper(k._id, { bedroom: target, bed: null, caretakerId: me._id });
      touched.add(k._id);
    }
  } else {
    const full = await bedroomFullMessage(target, me.bedroom);
    if (full) return fail(c, "BEDROOM_FULL", full, 409);
    await setStaffBedroom(me._id, target, {});
    await reassignCampers(me._id, null);
    for (const k of myKids) touched.add(k._id);
    void notifyCaretakerChange(myKids, me, null);
  }

  const after = (await findStaffById(me._id))!;
  publish("staff", "bedrooms", "campers", "instructions", "preparation");
  void notifyStaffChange(me, after);
  if (other) void findStaffById(other._id).then((o) => o && notifyStaffChange(other, o));
  return c.json({ staff: serialize(after), movedKids: touched.size });
});

/**
 * DELETE /api/staff/:id — the person leaves this camp's operations; the
 * `equipe` membership is removed in projects-api when the coordenação token
 * may (best effort, `membershipRemoved`). Their other project roles are
 * managed in Mordomia.
 */
staff.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await deleteStaff(id);
  if (!ok) return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
  const [, orphaned] = await Promise.all([unassignStaffEverywhere(id), reassignCampers(id, null)]);
  publish("staff", "bedrooms", "events", ...(orphaned ? ["campers" as const] : []));
  let membershipRemoved = false;
  const token = coordinationToken(c.get("session"), PROJECTS_RESOURCE);
  const editionId = await campEditionId();
  if (token && editionId) {
    membershipRemoved = await coreClient()
      .removeMembership(token, { personId: id, role: TEAM_ROLE, editionId })
      .then(() => true)
      .catch(() => false);
  }
  return c.json({ success: true, membershipRemoved });
});

export default staff;
