import { Hono, type Context } from "hono";
import { publish } from "../services/realtime";
import { notifyBusCheckin, notifyCamperChange, notifyForeignLookupAlert, notifyParentEdit } from "../services/notify";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireManager, requireRole } from "../middleware/roles";
import { findBedroomById } from "../models/bedrooms";
import { insertCamperLookup } from "../models/camperLookups";
import { CHECKIN_FIELD, deleteCamper, EMPTY_CAMPER, findCamperById, insertCamper, listCamperChanges, listCampers, listCheckinLog, logCamperChange, logCheckin, setCamperCheckin, updateCamper, type CamperData } from "../models/campers";
import { FOREIGN_LOOKUP_ALERT_AT, FOREIGN_LOOKUP_BLOCK_AT, findStaffById, listStaff, markForeignLookupAlerted, recordForeignLookup } from "../models/staff";
import { participantKind } from "../models/participants";
import { CAMPER_CATEGORY_KEYS, MEDICAL_EDITABLE_FIELDS, PARENT_EDITABLE_FIELDS, PARTICIPANT_ROLE, RESPONSIBLE_ROLE, type Camper, type CamperChangeField, type CamperChangeLog, type CheckinKind, type HealthInfo, type MedicalEditableField, type ParentEditableField } from "../types";
import { isInvalid, parseBedroom, parseMedications, parseSingle, parseTeam, parseText, parseTransport, bedroomFullMessage } from "./_validate";
import { serializeStaffList } from "./staff";
import { camperVisibility, canParentEdit, canRunBusCheckin, canRunCheckin, isParent, resolveScope, type Scope } from "../services/scope";
import { campInProgress, campPeriod } from "../services/camp";
import { actingToken, campEditionId, coordinationToken } from "../services/acting";
import { healthToCore, mergeHealthInto, registrationData, registrationExtras, registrationProfile } from "../services/coreRegistration";
import { coreClient } from "../services/ipalpha";
import { PERSONS_RESOURCE, PROJECTS_RESOURCE } from "../services/ipalpha/coreClient";
import { hasHealthInfo, healthCounts, healthFlagsOf, matchesHealthTag, nameMatches, namesOf, pageOf, readHealth, readHealthMany, readHealthState, tagFilter, writeHealth } from "../services/people";
import { editionRolesOf, responsiblesOf } from "../services/members";
import { normalizeBrazilPhone, titleCaseName } from "../utils";

/**
 * /api/campers — the kids of the camp: `participants` rows (camp ops) keyed by
 * the IPAlpha person id. Names come live from core (the requester's role token) for the
 * PAGE being shown; health only with the acting role token (persons-api role
 * rules decide), and in lists only when a health filter is on or a name filter
 * narrowed the list to ≤ 6 kids (decision 31). Nothing about the person is
 * stored here.
 */
const campers = new Hono<{ Variables: AuthVariables }>();

const TEXT_MAX = 1000;
const SHORT_MAX = 120;
const NAME_MAX = 100;
const WEIGHT_MIN = 5;
const WEIGHT_MAX = 200;
/** a name filter at or under this many matches shows the health tags (decision 31) */
export const HEALTH_DETAIL_MAX = 6;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 | 409 | 502 = 400) {
  return c.json({ error: { code, message } }, status);
}

/** Camp-ops record of a kid (no person data). */
export function serializeCamper(k: Camper) {
  return {
    id: k._id,
    personId: k.personId,
    invitedBy: k.invitedBy,
    caretakerId: k.caretakerId,
    qrToken: k.qrToken,
    team: k.team,
    transportation: k.transportation,
    bed: k.bed,
    bedroom: k.bedroom,
    generalNotes: k.generalNotes,
    bedroomPreference: k.bedroomPreference,
    checkin: k.checkin,
    busCheckin: k.busCheckin,
    busReturnCheckin: k.busReturnCheckin,
    parentEditedAt: k.parentEditedAt,
    importId: k.importId,
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
  };
}

/**
 * The kid's camp-ops record according to the viewer's scope, or null when
 * invisible. "name" visibility (bus / score helpers) drops notes, preferences
 * and the bed; "care" drops the invitedBy / qrToken / import bookkeeping.
 * Health travels apart and is cut by `healthFor` (care = `CARE_HEALTH_FIELDS`).
 */
export function serializeCamperFor(k: Camper, scope: Scope) {
  const vis = camperVisibility(scope, k);
  if (vis === "none") return null;
  const full = serializeCamper(k);
  if (vis === "full" && !scope.all && scope.kidsRoomsDraft && scope.parentKids.length > 0) return { ...full, bedroom: null, bed: null, caretakerId: null };
  if (vis === "full") return full;
  if (vis === "care") return { ...full, invitedBy: "", qrToken: "", importId: null, contactsHidden: true };
  return { ...full, redacted: true, invitedBy: "", qrToken: "", bed: null, generalNotes: "", bedroomPreference: "", parentEditedAt: null, importId: null };
}

export function serializeCamperList(list: Camper[], scope: Scope) {
  return list.map((k) => serializeCamperFor(k, scope)).filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * The health a CARE reader gets — a room caretaker / helper, a check-in helper
 * and a badge scan out of the scanner's room: what they need to look after the
 * kid today, nothing more (the old app's "care" record).
 */
export const CARE_HEALTH_FIELDS = ["allergies", "drugAllergies", "healthIssues", "foodRestrictions", "medications"] as const;
export type CareHealth = Pick<HealthInfo, (typeof CARE_HEALTH_FIELDS)[number]>;

export function careHealth(h: HealthInfo): CareHealth {
  return { allergies: h.allergies, drugAllergies: h.drugAllergies, healthIssues: h.healthIssues, foodRestrictions: h.foodRestrictions, medications: h.medications };
}

/**
 * Whole health block (incl. neurodivergence — a diagnosis — and the insurance +
 * card — a document): only the coordenação (`scope.all`) and saúde, plus a
 * responsável for their OWN kid (the family's own data, which they edit).
 * Everyone else gets `careHealth`.
 */
export function wholeHealthAllowed(scope: Scope, k: Pick<Camper, "_id">): boolean {
  return scope.all ? scope.admin : scope.medical || canParentEdit(scope, k);
}

/** `h` cut down to what the acting role may see of `k`. */
export function healthFor(h: HealthInfo | null, scope: Scope, k: Pick<Camper, "_id">): HealthInfo | CareHealth | null {
  if (!h) return null;
  return wholeHealthAllowed(scope, k) ? h : careHealth(h);
}

/** May the acting role see health at all (the person page / filters)? Core still decides per read; `healthFor` cuts what is shown. */
export function healthAllowed(scope: Scope, k?: Pick<Camper, "_id" | "bedroom" | "transportation" | "caretakerId">): boolean {
  if (scope.all || scope.medical || scope.checkinHelper) return true;
  if (!k) return false;
  const vis = camperVisibility(scope, k);
  return vis === "full" || vis === "care";
}

// ── validation of camp-ops / health input ─────────────────────────────────────

async function buildOpsPatch(body: Record<string, unknown>): Promise<{ patch: Partial<CamperData> } | { code: string; message: string }> {
  const patch: Partial<CamperData> = {};
  const has = (k: string) => body[k] !== undefined;
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
  if (has("bed")) {
    const v = await parseSingle(body.bed, CAMPER_CATEGORY_KEYS.bed, "Cama");
    if (isInvalid(v)) return { code: "BED_INVALID", message: v.error };
    patch.bed = v;
  }
  if (has("bedroom")) {
    const v = await parseBedroom(body.bedroom);
    if (isInvalid(v)) return { code: "BEDROOM_INVALID", message: v.error };
    patch.bedroom = v;
  }
  if (has("caretakerId")) {
    const v = body.caretakerId;
    if (v === null || v === "") patch.caretakerId = null;
    else if (typeof v !== "string" || !(await findStaffById(v))) return { code: "CARETAKER_INVALID", message: "Líder não encontrado." };
    else patch.caretakerId = v;
  }
  for (const field of ["invitedBy", "qrToken"] as const) {
    if (!has(field)) continue;
    const v = parseText(body[field], SHORT_MAX);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }
  for (const field of ["generalNotes", "bedroomPreference"] as const) {
    if (!has(field)) continue;
    const v = parseText(body[field], TEXT_MAX);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }
  return { patch };
}

/** Health fields of a body → a persons-api `medical` patch (option ids are validated by core against its health lists). */
function buildHealthPatch(body: Record<string, unknown>, allowed: readonly string[]): { patch: Partial<HealthInfo> } | { code: string; message: string } {
  const patch: Partial<HealthInfo> = {};
  const has = (k: string) => allowed.includes(k) && body[k] !== undefined;
  for (const field of ["allergies", "drugAllergies", "healthIssues"] as const) {
    if (!has(field)) continue;
    const v = body[field];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { code: `${field.toUpperCase()}_INVALID`, message: "Lista inválida." };
    patch[field] = [...new Set(v as string[])];
  }
  if (has("neurodivergent")) {
    if (typeof body.neurodivergent !== "boolean") return { code: "NEURODIVERGENT_INVALID", message: "Neurodivergência: responda sim ou não." };
    patch.neurodivergent = body.neurodivergent;
  }
  if (has("medications")) {
    const v = parseMedications(body.medications);
    if (isInvalid(v)) return { code: "MEDICATIONS_INVALID", message: v.error };
    patch.medications = v;
  }
  for (const [field, max] of [["foodRestrictions", 300], ["healthNotes", 2000], ["insurance", 60], ["insuranceCard", 60]] as const) {
    if (!has(field)) continue;
    const v = parseText(body[field], max);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }
  if (has("weightKg")) {
    const v = body.weightKg;
    if (v === null || v === "") patch.weightKg = null;
    else {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
      if (!Number.isFinite(n) || n < WEIGHT_MIN || n > WEIGHT_MAX) return { code: "WEIGHT_INVALID", message: `Peso inválido (entre ${WEIGHT_MIN} e ${WEIGHT_MAX} kg).` };
      patch.weightKg = Math.round(n * 10) / 10;
    }
  }
  return { patch };
}

/** The caretaker must sleep in the kid's room and be a CARETAKER there. Returns an error message or null. */
async function caretakerConsistent(bedroom: string | null, caretakerId: string | null): Promise<string | null> {
  if (!caretakerId) return null;
  const s = await findStaffById(caretakerId);
  if (!s) return "Líder não encontrado.";
  if (!bedroom || s.bedroom !== bedroom) return "Esta pessoa da equipe não dorme neste quarto.";
  if (s.roomRole !== "caretaker") return "Esta pessoa é auxiliar neste quarto, não líder.";
  return null;
}

campers.use("*", requireAuth);

// ── read ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/campers?cursor&limit&bedroom&q&tag — one PAGE of the kids the
 * viewer may see: camp-ops record + `name` / `nickname` (live, this page only)
 * + `hasHealth` (neutral ♥, health-allowed roles). `health` details only with
 * a `tag` filter (e.g. `allergies:<optionId>`, `medications`) or when `q`
 * narrows the list to ≤ 6 kids. `{items, nextCursor, total}`.
 */
campers.get("/", requireRole("admin", "staff", "parent"), async (c) => {
  const bedroom = c.req.query("bedroom") || undefined;
  const q = (c.req.query("q") ?? "").trim();
  const tag = (c.req.query("tag") ?? "").trim();
  const [list, scope] = await Promise.all([listCampers({ bedroom }), resolveScope(c.get("user"))]);
  let visible = list.filter((k) => camperVisibility(scope, k) !== "none");
  const mayHealth = (k: Camper) => healthAllowed(scope, k);

  let names = new Map<string, { name: string; nickname: string | null; sex: "F" | "M" | null }>();
  if (q) {
    names = await namesOf(visible.map((k) => k._id));
    visible = visible.filter((k) => nameMatches(names.get(k._id)?.name ?? "", q) || nameMatches(names.get(k._id)?.nickname ?? "", q));
  }
  let health = new Map<string, HealthInfo>();
  if (tag) {
    if (!tagFilter(tag)) return fail(c, "TAG_INVALID", "Filtro de saúde inválido.");
    // filtering by neurodivergence would reveal it: only the roles that see the whole block (a family filters only their own kids)
    if (tag.split(":", 1)[0] === "neurodivergent" && !(scope.all || scope.medical || isParent(scope))) return fail(c, "FORBIDDEN", "Este filtro não está disponível para o seu perfil.", 403);
    const allowed = visible.filter(mayHealth);
    health = await readHealthMany(actingToken(c, PERSONS_RESOURCE), allowed.map((k) => k._id));
    visible = allowed.filter((k) => health.has(k._id) && matchesHealthTag(health.get(k._id)!, tag));
  }
  const page = pageOf(visible, c.req.query("cursor"), Number(c.req.query("limit") ?? 50));
  const missing = page.items.filter((k) => !names.has(k._id)).map((k) => k._id);
  if (missing.length) for (const [id, n] of await namesOf(missing)) names.set(id, n);
  const detail = !!tag || (!!q && visible.length <= HEALTH_DETAIL_MAX);
  // details only when filtered (tag / a name narrowing to ≤ 6): the medical block is read for those few
  if (detail) {
    const need = page.items.filter((k) => mayHealth(k) && !health.has(k._id)).map((k) => k._id);
    if (need.length) for (const [id, h] of await readHealthMany(actingToken(c, PERSONS_RESOURCE), need)) health.set(id, h);
  }
  // otherwise the neutral ♥ comes from core's light flag (decision 69) — never a full medical read
  const flagIds = page.items.filter((k) => mayHealth(k) && !health.has(k._id)).map((k) => k._id);
  const flags = flagIds.length ? await healthFlagsOf(actingToken(c, PERSONS_RESOURCE), flagIds) : new Map<string, boolean>();
  const items = page.items.map((k) => {
    const h = mayHealth(k) ? health.get(k._id) : undefined;
    const hasHealth = h ? hasHealthInfo(h) : flags.get(k._id) === true;
    return {
      ...serializeCamperFor(k, scope)!,
      name: names.get(k._id)?.name ?? "",
      nickname: names.get(k._id)?.nickname ?? null,
      sex: names.get(k._id)?.sex ?? null,
      ...(mayHealth(k) ? { hasHealth } : {}),
      ...(detail && h ? { health: healthFor(h, scope, k) } : {}),
    };
  });
  return c.json({ items, nextCursor: page.nextCursor, total: visible.length });
});

/**
 * GET /api/campers/health-counts?tags=allergies:<id>,medications — the chip
 * counts of the health filter (anonymized count endpoint, not logged).
 */
campers.get("/health-counts", requireRole("admin", "staff"), async (c) => {
  const scope = await resolveScope(c.get("user"));
  if (!(scope.all || scope.medical || scope.checkinHelper)) return fail(c, "FORBIDDEN", "Você não tem permissão para ver estes números.", 403);
  const tags = (c.req.query("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 50);
  const filters = tags.map(tagFilter).filter((f): f is NonNullable<typeof f> => !!f);
  const merged: Record<string, unknown> = {};
  for (const f of filters) for (const [k, v] of Object.entries(f)) merged[k] = Array.isArray(v) ? [...new Set([...((merged[k] as string[]) ?? []), ...v])] : v;
  // these roles see every kid of the camp: core counts the edition's `participante` members (no ids sent — decision 56)
  const editionId = await campEditionId();
  if (!editionId) return c.json({ total: 0, byTag: {} });
  return c.json(await healthCounts(actingToken(c, PERSONS_RESOURCE), PARTICIPANT_ROLE, merged, editionId));
});

/**
 * GET /api/campers/lookup/:id — emergency QR lookup (only while the camp is
 * happening). In-scope → the record (`belonged: true`, health per `healthFor`);
 * otherwise a CARE view (health = `CARE_HEALTH_FIELDS` only), the scan is logged (person ids only) and counted: ≥3 alerts the
 * coordenação, ≥5 blocks.
 */
campers.get("/lookup/:id", requireRole("admin", "staff"), async (c) => {
  if (!campInProgress(await campPeriod())) return fail(c, "CAMP_NOT_ACTIVE", "A leitura de crachás só funciona durante o acampamento.", 403);
  const user = c.get("user");
  const scope = await resolveScope(user);
  const k = await findCamperById(c.req.param("id"));
  if (!k) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const vis = camperVisibility(scope, k);
  const belonged = scope.all || vis === "full" || vis === "care";
  const token = actingToken(c, PERSONS_RESOURCE);
  const name = (await namesOf([k._id])).get(k._id)?.name ?? "";
  if (belonged) {
    return c.json({ camper: { ...(serializeCamperFor(k, scope) ?? serializeCamper(k)), name, health: healthFor(await readHealth(token, k._id), scope, k) }, belonged: true, foreignLookupCount: 0, foreignLookupBlocked: false });
  }
  const me = scope.staffId ? await findStaffById(scope.staffId) : null;
  if (!me || !me.active) return fail(c, "STAFF_NOT_LINKED", "Você não está na equipe deste acampamento.", 403);
  if (me.foreignLookupCount >= FOREIGN_LOOKUP_BLOCK_AT) {
    return c.json({ error: { code: "LOOKUP_BLOCKED", message: `Você já leu ${me.foreignLookupCount} crianças que não são do seu quarto. Peça à organização para liberar o acesso.`, foreignLookupCount: me.foreignLookupCount } }, 403);
  }
  const [bedroom, caretaker] = await Promise.all([k.bedroom ? findBedroomById(k.bedroom) : null, k.caretakerId ? findStaffById(k.caretakerId) : null]);
  await insertCamperLookup({ at: new Date(), camperId: k._id, byStaffId: me._id, belonged: false });
  const updated = (await recordForeignLookup(me._id, k._id)) ?? me;
  if (updated.foreignLookupCount >= FOREIGN_LOOKUP_ALERT_AT && !updated.foreignLookupAlertedAt) {
    await markForeignLookupAlerted(me._id);
    void notifyForeignLookupAlert(updated, updated.foreignLookupCount);
  }
  if (updated.foreignLookupCount >= FOREIGN_LOOKUP_ALERT_AT) publish("staff", "settings");
  else publish("staff");
  const caretakerName = caretaker ? ((await namesOf([caretaker._id])).get(caretaker._id)?.name ?? "") : "";
  // out of the scanner's room: the CARE health only — never neurodivergence or the insurance
  const scanned = await readHealth(token, k._id);
  return c.json({
    camper: { ...serializeCamper(k), invitedBy: "", qrToken: "", contactsHidden: true, name, health: scanned ? careHealth(scanned) : null },
    bedroom: bedroom ? { id: bedroom._id, name: bedroom.name, group: bedroom.group } : null,
    caretaker: caretaker ? { id: caretaker._id, name: caretakerName } : null,
    belonged: false,
    foreignLookupCount: updated.foreignLookupCount,
    foreignLookupBlocked: updated.foreignLookupCount >= FOREIGN_LOOKUP_BLOCK_AT,
  });
});

/** GET /api/campers/checkin/log — the whole audit trail (managers); names via POST /api/people/names. */
function serializeLog(l: Awaited<ReturnType<typeof listCheckinLog>>[number]) {
  return { id: l._id, who: l.who ?? "camper", personId: l.personId, kind: l.kind ?? "church", action: l.action, at: l.at, byPersonId: l.byPersonId, byRole: l.byRole, note: l.note ?? null };
}
campers.get("/checkin/log", requireManager, async (c) => c.json({ log: (await listCheckinLog()).map(serializeLog) }));

/**
 * GET /api/campers/:id — the kid's page: camp ops + name + (when the role may)
 * health and the responsáveis (ids + names). Out of scope = 404 (no probing).
 * Health is read with the ACTING role token — for a family that is the
 * `responsavel` token, and core lets it reach only their own kids (§19
 * `onlyInvolved`). When core refuses, `healthForbidden: true` (and `health:
 * null`) so the screen says "not available for your profile" instead of
 * "nothing informed".
 */
campers.get("/:id", requireRole("admin", "staff", "parent"), async (c) => {
  const k = await findCamperById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  const out = k ? serializeCamperFor(k, scope) : null;
  if (!k || !out) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const names = await namesOf([k._id]);
  const withHealth = healthAllowed(scope, k);
  const vis = camperVisibility(scope, k);
  const [healthState, responsibles] = await Promise.all([
    withHealth ? readHealthState(actingToken(c, PERSONS_RESOURCE), k._id) : null,
    vis === "full" || vis === "care" ? responsiblesOf([k._id]).then((m) => m.get(k._id) ?? []) : Promise.resolve([] as string[]),
  ]);
  const rNames = await namesOf(responsibles);
  return c.json({
    camper: {
      ...out,
      name: names.get(k._id)?.name ?? "",
      nickname: names.get(k._id)?.nickname ?? null,
      sex: names.get(k._id)?.sex ?? null,
      ...(healthState ? { health: healthFor(healthState.health, scope, k), ...(healthState.forbidden ? { healthForbidden: true } : {}) } : {}),
      responsibles: responsibles.map((id) => ({ personId: id, name: rNames.get(id)?.name ?? "" })),
    },
  });
});

/**
 * GET /api/campers/:id/responsibles — the kid's name + the responsáveis (ids + live names),
 * for the 📞 button: the same role guard, scope and responsáveis rule as GET /:id, and
 * NO health read (never a medical block — the button only needs who to call).
 * Out of scope = 404; in scope but the visibility does not reach the responsáveis
 * (anything but "full" / "care") = `responsibles: []`. Names are read live, never stored.
 */
campers.get("/:id/responsibles", requireRole("admin", "staff", "parent"), async (c) => {
  const k = await findCamperById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  if (!k || !serializeCamperFor(k, scope)) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const vis = camperVisibility(scope, k);
  const responsibles = vis === "full" || vis === "care" ? ((await responsiblesOf([k._id])).get(k._id) ?? []) : [];
  const names = await namesOf([k._id, ...responsibles]);
  return c.json({
    camper: { id: k._id, name: names.get(k._id)?.name ?? "" },
    responsibles: responsibles.map((id) => ({ personId: id, name: names.get(id)?.name ?? "" })),
  });
});

/** GET /api/campers/:id/detail — the kid + their room + the team of the room + roommates (camp ops; names via /api/people/names). */
campers.get("/:id/detail", requireRole("admin", "staff"), async (c) => {
  const k = await findCamperById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  const out = k ? serializeCamperFor(k, scope) : null;
  if (!k || !out) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const [bedroom, allStaff, roommates] = await Promise.all([k.bedroom ? findBedroomById(k.bedroom) : null, k.bedroom ? listStaff() : [], k.bedroom ? listCampers({ bedroom: k.bedroom }) : []]);
  return c.json({
    camper: out,
    bedroom: bedroom ? { id: bedroom._id, name: bedroom.name, group: bedroom.group } : null,
    caretakers: serializeStaffList(allStaff.filter((s) => s.bedroom === k.bedroom), scope),
    roommates: serializeCamperList(roommates.filter((x) => x._id !== k._id), scope),
  });
});

// ── check-in ──────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<CheckinKind, string> = {
  church: "o check-in",
  bus: "o check-in no ônibus para o acampamento",
  bus_return: "o check-in no ônibus de volta para a igreja",
};

async function doCheckin(c: Context<{ Variables: AuthVariables }>, kind: CheckinKind, action: "checkin" | "undo") {
  const [existing, scope] = await Promise.all([findCamperById(c.req.param("id") ?? ""), resolveScope(c.get("user"))]);
  const allowed = existing ? (kind === "church" ? canRunCheckin(scope) : canRunBusCheckin(scope, existing, kind)) : canRunCheckin(scope) || (!scope.all && scope.busHelperVehicle !== null);
  if (!allowed) return fail(c, "CHECKIN_WINDOW_CLOSED", "O check-in não está liberado para você neste momento.", 403);
  if (!existing) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const current = existing[CHECKIN_FIELD[kind]];
  if (action === "checkin" && current) return fail(c, "ALREADY_CHECKED_IN", `Esta criança já fez ${KIND_LABEL[kind]}.`, 409);
  if (action === "undo" && !current) return fail(c, "NOT_CHECKED_IN", `Esta criança ainda não fez ${KIND_LABEL[kind]}.`, 409);
  if (kind === "bus" && action === "checkin" && !existing.checkin) return fail(c, "CHURCH_CHECKIN_REQUIRED", "Esta criança ainda não fez o check-in na igreja.", 409);
  if (kind === "bus_return" && action === "checkin" && !existing.busCheckin) return fail(c, "OUTBOUND_BUS_CHECKIN_REQUIRED", "Esta criança não fez o check-in do ônibus na ida.", 409);
  const user = c.get("user");
  const stamp = { at: new Date(), byPersonId: user.id, byRole: user.coreRole };
  const updated = await setCamperCheckin(existing._id, kind, action === "checkin" ? stamp : null);
  await logCheckin({ who: "camper", personId: existing._id, kind, action, ...stamp });
  publish("campers");
  if (kind === "bus" && action === "checkin") void notifyBusCheckin(updated!);
  return c.json({ camper: serializeCamperFor(updated!, scope) });
}

const TEAM_OR_ADMIN = requireRole("admin", "staff");
campers.post("/:id/checkin", TEAM_OR_ADMIN, (c) => doCheckin(c, "church", "checkin"));
campers.delete("/:id/checkin", TEAM_OR_ADMIN, (c) => doCheckin(c, "church", "undo"));
campers.post("/:id/checkin/bus", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus", "checkin"));
campers.delete("/:id/checkin/bus", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus", "undo"));
campers.post("/:id/checkin/bus-return", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus_return", "checkin"));
campers.delete("/:id/checkin/bus-return", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus_return", "undo"));

campers.get("/:id/checkin/log", requireManager, async (c) => {
  const k = await findCamperById(c.req.param("id"));
  if (!k) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  return c.json({ log: (await listCheckinLog(k._id)).map(serializeLog) });
});

// ── edits of the kid's health (persons-api) and notes (Acampa) ──────────────────

function serializeChange(l: CamperChangeLog) {
  return { id: l._id, personId: l.personId, at: l.at, byPersonId: l.byPersonId, byRole: l.byRole, medical: l.medical, fields: l.fields };
}

/** GET /api/campers/:id/changes — which fields were edited, by whom and when (managers). */
campers.get("/:id/changes", requireManager, async (c) => {
  const k = await findCamperById(c.req.param("id"));
  if (!k) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  return c.json({ changes: (await listCamperChanges(k._id)).map(serializeChange) });
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies a health / notes edit: health through persons-api with the ACTING
 * role token (core's role rules decide), notes into the participant row; the
 * change log keeps only which fields changed.
 */
async function applyKidEdit(c: Context<{ Variables: AuthVariables }>, k: Camper, scope: Scope, fields: readonly string[], parentEdit: boolean) {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const touched = fields.filter((f) => body[f] !== undefined);
  if (touched.length === 0) return fail(c, "NOTHING_TO_UPDATE", "Nada para atualizar.");
  const health = buildHealthPatch(body, fields);
  if (!("patch" in health)) return fail(c, health.code, health.message);
  const token = actingToken(c, PERSONS_RESOURCE);
  // option ids may be the church health lists' (preferred) or Acampa's import categories — mapped by label
  if (["allergies", "drugAllergies", "healthIssues"].some((f) => f in health.patch)) health.patch = await healthToCore(token, health.patch);
  const state = Object.keys(health.patch).length ? await readHealthState(token, k._id) : null;
  // a block the role may not read is never written over (it would erase what is there) — nothing is saved
  if (state?.forbidden) return c.json({ error: { code: "CORE_FORBIDDEN", reason: "medicalForbidden", message: "O IPAlpha não permitiu esta operação para o seu perfil." } }, 403);
  const current = state?.health ?? null;
  const changed: CamperChangeField[] = [];
  for (const f of Object.keys(health.patch) as (keyof HealthInfo)[]) if (!current || !same(current[f], health.patch[f])) changed.push(f as CamperChangeField);
  let notes: string | undefined;
  if (fields.includes("generalNotes") && body.generalNotes !== undefined) {
    const v = parseText(body.generalNotes, TEXT_MAX);
    if (isInvalid(v)) return fail(c, "GENERALNOTES_INVALID", v.error);
    if (v !== k.generalNotes) {
      notes = v;
      changed.push("generalNotes");
    }
  }
  if (changed.length === 0) return c.json({ camper: { ...serializeCamperFor(k, scope)!, health: current }, changed: false });
  const healthChanged = changed.filter((f) => f !== "generalNotes");
  const nextHealth = healthChanged.length ? await writeHealth(token, k._id, health.patch, current) : current;
  const updated = notes !== undefined ? (await updateCamper(k._id, { generalNotes: notes }))! : k;
  const user = c.get("user");
  const entry = { personId: k._id, at: new Date(), byPersonId: user.id, byRole: user.coreRole, medical: healthChanged.length > 0, fields: changed };
  await logCamperChange(entry, parentEdit);
  publish("campers");
  if (parentEdit) void notifyParentEdit(updated, entry);
  return c.json({ camper: { ...serializeCamperFor(updated, scope)!, health: nextHealth }, changed: true });
}

/** PUT /api/campers/:id/parent — a responsável edits THEIR kid's health block (persons-api) and / or observations. */
campers.put("/:id/parent", requireRole("parent"), async (c) => {
  const [existing, scope] = await Promise.all([findCamperById(c.req.param("id")), resolveScope(c.get("user"))]);
  if (!existing || !canParentEdit(scope, existing)) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  return applyKidEdit(c, existing, scope, PARENT_EDITABLE_FIELDS as readonly ParentEditableField[], true);
});

/** PUT /api/campers/:id/health — the medical team (`saude`) / coordenação edits a kid's health (persons-api). */
campers.put("/:id/health", requireRole("admin", "staff"), async (c) => {
  const [existing, scope] = await Promise.all([findCamperById(c.req.param("id")), resolveScope(c.get("user"))]);
  if (!existing || !(scope.all || scope.medical)) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  return applyKidEdit(c, existing, scope, MEDICAL_EDITABLE_FIELDS as readonly MedicalEditableField[], false);
});

// ── write: coordenação / organização ────────────────────────────────────────────

campers.use("/*", requireManager);

/**
 * POST /api/campers/register — a NEW kid (and responsável) through core with
 * the coordenação token (§12): persons registration (responsible + child +
 * link), memberships `participante` (involved responsável) + `responsavel`
 * in the camp's edition, then the participant row. The kid's optional `sex`
 * ("F" | "M"), `homeChurch`, `school {name, grade}` and `emergencyContact`
 * travel IN the registration (core `RegistrationPersonDto`); `health` is
 * merged afterwards over what core already holds (a kid core knows keeps
 * every allergy / medicine — `mergeHealthInto`). Answer `medical`:
 * "written" | "unchanged" | "refused".
 * Body: `{ name, birthDate, responsible: { name, phone }, sex?, homeChurch?, school?, emergencyContact?, health?, ...camp ops }`.
 */
campers.post("/register", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const name = typeof body.name === "string" ? titleCaseName(body.name) : "";
  if (!name || name.length > NAME_MAX) return fail(c, "NAME_INVALID", `Informe um nome com até ${NAME_MAX} caracteres.`);
  const birthDate = typeof body.birthDate === "string" && DATE_RE.test(body.birthDate) ? body.birthDate : null;
  if (!birthDate) return fail(c, "BIRTH_DATE_INVALID", "Data de nascimento inválida.");
  const resp = body.responsible && typeof body.responsible === "object" ? (body.responsible as Record<string, unknown>) : null;
  const respName = typeof resp?.name === "string" ? titleCaseName(resp.name) : "";
  const respPhone = typeof resp?.phone === "string" ? normalizeBrazilPhone(resp.phone) : null;
  if (!respName || !respPhone) return fail(c, "RESPONSIBLE_INVALID", "Informe o nome e o celular do responsável.");
  const ops = await buildOpsPatch(body);
  if (!("patch" in ops)) return fail(c, ops.code, ops.message);
  const health = buildHealthPatch((body.health as Record<string, unknown>) ?? {}, MEDICAL_EDITABLE_FIELDS);
  if (!("patch" in health)) return fail(c, health.code, health.message);
  const extras = registrationExtras(body);
  if (!extras.ok) return fail(c, extras.code, extras.message);
  const session = c.get("session");
  const personsToken = coordinationToken(session, PERSONS_RESOURCE);
  const projectsToken = coordinationToken(session, PROJECTS_RESOURCE);
  if (!personsToken || !projectsToken) return fail(c, "COORDINATION_REQUIRED", "Só a coordenação cadastra pessoas.", 403);
  const editionId = await campEditionId();
  if (!editionId) return fail(c, "EDITION_UNKNOWN", "A edição deste acampamento ainda não existe no IPAlpha.", 409);
  const data = ops.patch;
  const full = await bedroomFullMessage(data.bedroom ?? null, null);
  if (full) return fail(c, "BEDROOM_FULL", full, 409);
  const bad = await caretakerConsistent(data.bedroom ?? null, data.caretakerId ?? null);
  if (bad) return fail(c, "CARETAKER_INVALID", bad, 409);

  const client = coreClient();
  const kidData = registrationData(extras.data);
  const reg = await client.register(personsToken, { role: PARTICIPANT_ROLE, responsible: { name: respName, phone: respPhone }, children: [{ name, birthDate, ...registrationProfile(extras), ...(kidData ? { data: kidData } : {}) }] });
  const child = reg.children[0];
  if (!reg.responsible || !child) return fail(c, "REGISTRATION_FAILED", "O IPAlpha não confirmou o cadastro.", 502);
  if (await participantKind(child.personId)) return fail(c, "ALREADY_IN_CAMP", "Esta pessoa já está neste acampamento.", 409);
  await client.addMembership(projectsToken, {
    personId: child.personId,
    role: PARTICIPANT_ROLE,
    editionId,
    ...(child.linkId ? { onBehalf: { by: reg.responsible.personId, via: child.linkId } } : {}),
    involved: [{ personId: reg.responsible.personId, purpose: "responsible", kinds: [] }],
  });
  await client.addMembership(projectsToken, { personId: reg.responsible.personId, role: RESPONSIBLE_ROLE, editionId });
  const medical = await mergeHealthInto(personsToken, child.personId, health.patch, { isNew: child.created });
  const created = await insertCamper(child.personId, { ...EMPTY_CAMPER, ...data });
  publish("campers", "bedrooms");
  void notifyCamperChange(null, created);
  return c.json({ camper: { ...serializeCamper(created), name }, responsible: { personId: reg.responsible.personId, created: reg.responsible.created }, medical }, 201);
});

/** POST /api/campers { personId, ...camp ops } — an existing IPAlpha person joins this camp's kids. */
campers.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const personId = typeof body.personId === "string" ? body.personId.trim() : "";
  if (!personId) return fail(c, "PERSON_REQUIRED", "Escolha a pessoa no IPAlpha.");
  if (await participantKind(personId)) return fail(c, "ALREADY_IN_CAMP", "Esta pessoa já está neste acampamento.", 409);
  // only a live `participante` of THIS camp's edition becomes a kid row (never an arbitrary person id)
  if (!(await editionRolesOf(personId)).includes(PARTICIPANT_ROLE)) return fail(c, "NOT_IN_EDITION", "Esta pessoa ainda não está inscrita como participante nesta edição no IPAlpha.", 409);
  const ops = await buildOpsPatch(body);
  if (!("patch" in ops)) return fail(c, ops.code, ops.message);
  const data = ops.patch;
  const full = await bedroomFullMessage(data.bedroom ?? null, null);
  if (full) return fail(c, "BEDROOM_FULL", full, 409);
  const bad = await caretakerConsistent(data.bedroom ?? null, data.caretakerId ?? null);
  if (bad) return fail(c, "CARETAKER_INVALID", bad, 409);
  const created = await insertCamper(personId, { ...EMPTY_CAMPER, ...data });
  publish("campers", "bedrooms");
  void notifyCamperChange(null, created);
  return c.json({ camper: serializeCamper(created) }, 201);
});

/** PUT /api/campers/:id — camp ops (room, bed, team, transport, caretaker, notes…). */
campers.put("/:id", async (c) => {
  const existing = await findCamperById(c.req.param("id"));
  if (!existing) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = await buildOpsPatch(body);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const patch = result.patch;
  if (patch.bedroom !== undefined && patch.bedroom !== existing.bedroom) {
    const full = await bedroomFullMessage(patch.bedroom, existing.bedroom);
    if (full) return fail(c, "BEDROOM_FULL", full, 409);
    if (patch.caretakerId === undefined) patch.caretakerId = null;
  }
  const bedroom = patch.bedroom !== undefined ? patch.bedroom : existing.bedroom;
  const caretakerId = patch.caretakerId !== undefined ? patch.caretakerId : existing.caretakerId;
  if (patch.bedroom !== undefined || patch.caretakerId !== undefined) {
    const bad = await caretakerConsistent(bedroom, caretakerId);
    if (bad) return fail(c, "CARETAKER_INVALID", bad, 409);
  }
  const updated = await updateCamper(existing._id, patch);
  publish("campers", "bedrooms");
  void notifyCamperChange(existing, updated);
  return c.json({ camper: serializeCamper(updated!) });
});

/**
 * DELETE /api/campers/:id — the kid leaves this camp's operations. The
 * `participante` membership is removed in projects-api when the coordenação
 * token may (best effort: `membershipRemoved` says whether it happened).
 */
campers.delete("/:id", async (c) => {
  const existing = await findCamperById(c.req.param("id"));
  const ok = existing ? await deleteCamper(existing._id) : false;
  if (!ok || !existing) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  publish("campers", "bedrooms");
  void notifyCamperChange(existing, null);
  let membershipRemoved = false;
  const token = coordinationToken(c.get("session"), PROJECTS_RESOURCE);
  const editionId = await campEditionId();
  if (token && editionId) {
    membershipRemoved = await coreClient()
      .removeMembership(token, { personId: existing._id, role: PARTICIPANT_ROLE, editionId })
      .then(() => true)
      .catch(() => false);
  }
  return c.json({ success: true, membershipRemoved });
});

export default campers;
