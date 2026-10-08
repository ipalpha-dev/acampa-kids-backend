import { findBedroomById, listBedrooms } from "../models/bedrooms";
import { findTransportById } from "../models/transports";
import { listRoles } from "../models/schedule";
import { claimBirthdayNoticeDay, claimCheckinReminder, getSettings, releaseBirthdayNoticeDay, staffAccessOpen } from "../models/settings";
import { claimStaffPhotosNotice, claimStaffWelcome, findStaffById, listStaff } from "../models/staff";
import { findTeamById, listTeams } from "../models/teams";
import { claimUserPhotosNotice, claimUserWelcome, findUserCampState, resetUserPhotosNoticeOf, resetUserWelcomeOf } from "../models/userCampState";
import { transportLabel as transportLabelOf } from "../routes/transports";
import { COORDINATION_ROLE, PARTICIPANT_ROLE, PREP_AUDIENCES, RESPONSIBLE_ROLE, TEAM_ROLE, type Bedroom, type Session, type CampEvent, type Camper, type CamperChangeLog, type DocAudience, type InstructionDoc, type Occurrence, type PrepAudience, type PrepSection, type RoomRole, type ScheduleRole, type Settings, type Staff, type Team } from "../types";
import { saoPauloWallClock, saoPauloWallClockToIso, todayInSaoPaulo } from "../utils";
import { campPeriod } from "./camp";
import { ipalphaEnabled } from "./ipalpha";
import { membersOf, responsiblesOf } from "./members";
import { previewMessage, sendMessage, sendToRoles, type SendInput } from "./messages";
import { firstName, namesOf } from "./people";
import { currentViewer, withViewerOf } from "./viewer";
import { assignmentDetail, autoRoleCovers, autoRoleFor, teamMap } from "./schedule";
import type { TemplateKey } from "../messages/templates";

/**
 * Who is told what, through the project's message templates (CONTRACTS §13,
 * services/messages.ts — notifications-api resolves the contact, the language
 * and logs the access for the person; Acampa only names person ids):
 *
 *   - a kid was put under / taken from someone's care (caretakers only)
 *   - someone's duty in an event changed (assigned, removed, moved, cancelled)
 *   - an Instruções / Preparação document changed (team; parents for sections
 *     posted to them, inside their access window)
 *   - the person's own room / room role / team / vehicle changed
 *   - the person's church check-in was recorded; the check-in reminder
 *   - an occurrence was registered (every coordenação member)
 *   - a family edited a kid's health (medical team + coordenação + caretaker)
 *   - the kid boarded the bus (the kid's responsáveis)
 *   - photos published, welcomes (team when its window opens, families)
 *
 * Member lists and names are read with the session of whoever caused the
 * message (services/viewer.ts — the queue remembers it). Where Acampa can no
 * longer read a list — families, the coordenação / medical team from a
 * non-coordenação request, helpers from a timer — the message goes to a role
 * `audience` that core resolves (shared variables only).
 *
 * Each kind can be switched off in Settings → Notificações. Plain team
 * members (`equipe`) are only messaged inside `settings.staffAccessWindow`;
 * helper roles and parent contacts always. Messages to the same person with
 * the same template inside NOTIFY_COALESCE_SECONDS collapse into the last one
 * (bulk edits never flood a phone). Delivery is best effort and never blocks
 * the write.
 *
 * Birthdays (decision 51): on a camp day at 07:45 São Paulo the team roles
 * get the birthday notice as an audience with `birthdayOf: participante` —
 * core finds today's birthdays and fills `{birthdayNames}` per recipient with
 * the kids that recipient's role sees (none → skipped); Acampa never learns
 * who, nor a date. Once per camp day: `settings.birthdayNoticeDay`.
 */

const COALESCE_MS = Number(process.env.NOTIFY_COALESCE_SECONDS ?? 20) * 1000;

interface Pending {
  key: TemplateKey;
  input: SendInput;
  /** team members are re-checked against the access window at send time */
  gate: "staff" | "parent" | "none";
  /** the session that caused it (names and member lists are read with its tokens), null from a timer */
  viewer: Session | null;
}

const queue = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** The helper roles (not plain `equipe` / `responsavel`) — never window-gated. */
async function helperRoles(): Promise<string[]> {
  const { ROLE_FLAGS } = await import("./scope");
  return Object.keys(ROLE_FLAGS).filter((r) => r !== TEAM_ROLE);
}

/** Person ids holding a helper role in this camp's edition, as far as the viewer may list them (none from a timer). */
async function helperIds(): Promise<Set<string>> {
  const lists = await Promise.all((await helperRoles()).map((r) => membersOf(r).catch(() => [])));
  return new Set(lists.flat().map((m) => m.personId));
}

/** The `userCampState` key of the families' once-per-camp marks (an audience, never a person id). */
const FAMILIES_MARK = `role:${RESPONSIBLE_ROLE}`;

async function gateOpen(p: Pending, settings: Settings, helpers: () => Promise<Set<string>>): Promise<boolean> {
  if (p.gate === "parent") return staffAccessOpen(settings.parentAccessWindow);
  if (p.gate === "staff") {
    if (staffAccessOpen(settings.staffAccessWindow)) return true;
    if (settings.parentContacts.some((c) => c.personId === p.input.personId)) return true;
    return (await helpers()).has(p.input.personId);
  }
  return true;
}

function enqueue(key: TemplateKey, input: SendInput, gate: Pending["gate"]): void {
  queue.set(`${input.personId}|${key}`, { key, input, gate, viewer: currentViewer() });
  if (COALESCE_MS <= 0) {
    void flushNotifications();
    return;
  }
  timer ??= setTimeout(() => {
    timer = null;
    void flushNotifications();
  }, COALESCE_MS);
}

/** Sends everything queued (tests call it directly). */
export async function flushNotifications(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const pending = [...queue.values()];
  queue.clear();
  if (pending.length === 0) return;
  try {
    const settings = await getSettings();
    const byViewer = new Map<string, Pending[]>();
    for (const p of pending) byViewer.set(p.viewer?._id ?? "", [...(byViewer.get(p.viewer?._id ?? "") ?? []), p]);
    for (const group of byViewer.values()) {
      await withViewerOf(group[0].viewer, async () => {
        let helperSet: Promise<Set<string>> | null = null;
        const helpers = () => (helperSet ??= helperIds());
        const byKey = new Map<TemplateKey, SendInput[]>();
        for (const p of group) {
          if (!(await gateOpen(p, settings, helpers))) continue;
          byKey.set(p.key, [...(byKey.get(p.key) ?? []), p.input]);
        }
        for (const [key, inputs] of byKey) await sendMessage(key, inputs);
      });
    }
  } catch (err) {
    console.error("notify: flush failed", err instanceof Error ? err.message : err);
  }
}

async function bedroomName(id: string | null): Promise<string> {
  return id ? ((await findBedroomById(id))?.name ?? "—") : "—";
}

async function transportLabel(id: string | null): Promise<string> {
  if (!id) return "—";
  const t = await findTransportById(id);
  return t ? transportLabelOf(t) : "—";
}

async function firstNames(ids: string[]): Promise<Map<string, string>> {
  const names = await namesOf(ids);
  return new Map(ids.map((id) => [id, firstName(names.get(id)?.name ?? "")]));
}

/** "Ana, João e Maria" (pt-BR join of first names; core renders the rest of the sentence per language) */
function joinNames(names: string[]): string {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} & ${list[list.length - 1]}`;
}

// ── check-in ─────────────────────────────────────────────────────────────────

/** The team member's church check-in was recorded (by themselves or the roll call). */
export async function notifyCheckin(staff: Staff): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.checkinConfirmation) return;
    enqueue("checkinConfirmed", { personId: staff._id, variables: { room: settings.kidsRoomsDraft ? "—" : await bedroomName(staff.bedroom) } }, "staff");
  } catch (err) {
    console.error("notify: checkin failed", err);
  }
}

/**
 * At `settings.checkinReminder.at` every active team member not checked in yet is reminded (once per instant).
 * Outside the team's access window only the parents' contacts are (by id) and the helper roles (audience: a
 * timer cannot list them; the ones already checked in are excluded).
 */
export async function sendCheckinReminder(now = new Date()): Promise<void> {
  try {
    const settings = await getSettings();
    const at = settings.checkinReminder.at;
    if (!settings.notifications.checkinReminder || !at || settings.checkinReminder.sentAt || now < at) return;
    if (!(await claimCheckinReminder(at))) return;
    const open = staffAccessOpen(settings.staffAccessWindow);
    const staff = await listStaff({ active: true });
    const team = staff.filter((s) => !s.checkin && (open || settings.parentContacts.some((p) => p.personId === s._id)));
    await sendMessage("checkinReminder", team.map((s) => ({ personId: s._id })));
    // helpers already checked in (or just reminded by id) are left out by core
    if (!open) await sendToRoles("checkinReminder", await helperRoles(), { excludePersonIds: [...staff.filter((s) => s.checkin).map((s) => s._id), ...team.map((s) => s._id)] });
  } catch (err) {
    console.error("notify: checkin reminder failed", err);
  }
}

// ── a kid's birthday on a camp day → the whole team of the room (decision 51) ─

const BIRTHDAY_SMS_TIME = "07:45";

/** The instant today's birthday message would be due (07:45 São Paulo on `day`). */
export function birthdaySmsDue(day: string): Date {
  return new Date(saoPauloWallClockToIso(saoPauloWallClock(day, BIRTHDAY_SMS_TIME)));
}

/** The roles told about a birthday: every team role (helpers, coordenação; plain `equipe` only inside its window). */
async function birthdayRoles(settings: Settings): Promise<string[]> {
  const helpers = await helperRoles();
  return [...new Set([...helpers, COORDINATION_ROLE, ...(staffAccessOpen(settings.staffAccessWindow) ? [TEAM_ROLE] : [])])];
}

/**
 * Sends today's birthday notice to the team (idempotent: hourly safety net + the 07:45 timer both call it). Only
 * on camp days, after 07:45, with the setting on. Core finds today's birthdays among the edition's kids.
 */
export async function sendBirthdayNotices(now = new Date()): Promise<void> {
  try {
    const today = todayInSaoPaulo(now);
    if (!ipalphaEnabled()) return;
    const settings = await getSettings();
    if (!settings.notifications.birthdays) return;
    const period = await campPeriod();
    if (!period.from || !period.until || today < period.from || today > period.until) return;
    if (now < birthdaySmsDue(today)) return;
    if (!(await claimBirthdayNoticeDay(today))) return;
    const accepted = await sendToRoles("birthday", await birthdayRoles(settings), { birthdayOf: [PARTICIPANT_ROLE] }, "birthday");
    // nothing went out (core down / refused): lift the marker so the hourly run tries again today
    if (accepted === null) await releaseBirthdayNoticeDay(today);
    // counts only — no person id or date that would tie the line to one kid's birthday
    else if (accepted) console.log(`🎂 birthday notices: ${accepted} message(s) accepted`);
  } catch (err) {
    console.error("notify: birthday notices failed", err instanceof Error ? err.message : err);
  }
}

// ── a family edited a kid's health / notes ───────────────────────────────────

/**
 * Medical fields → medical team (`saude`) + coordenação (role audience: a
 * family cannot list them) + the kid's caretaker; observations only → the
 * caretaker. Names the fields, never values.
 */
export async function notifyParentEdit(kid: Camper, entry: Pick<CamperChangeLog, "medical" | "byPersonId">): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.parentEdits) return;
    const kidName = (await firstNames([kid._id])).get(kid._id) ?? "";
    const key: TemplateKey = entry.medical ? "parentEditMedical" : "parentEditNotes";
    if (kid.caretakerId && !settings.kidsRoomsDraft && kid.caretakerId !== entry.byPersonId) enqueue(key, { personId: kid.caretakerId, variables: { kid: kidName } }, "staff");
    if (entry.medical) await sendToRoles("parentEditMedical", ["saude", COORDINATION_ROLE], { variables: { kid: kidName }, excludePersonIds: [entry.byPersonId, ...(kid.caretakerId ? [kid.caretakerId] : [])] });
  } catch (err) {
    console.error("notify: parent edit failed", err);
  }
}

// ── occurrences / out-of-scope badge scans ───────────────────────────────────

/** A new occurrence → every coordenação member but its author (role audience, sent at once). */
export async function notifyOccurrence(o: Occurrence): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.occurrences) return;
    await sendToRoles("occurrence", [COORDINATION_ROLE], { excludePersonIds: [o.createdByPersonId] });
  } catch (err) {
    console.error("notify: occurrence failed", err);
  }
}

/** A team member reached the out-of-scope badge scan threshold → every coordenação member. */
export async function notifyForeignLookupAlert(staff: Pick<Staff, "_id">, count: number): Promise<void> {
  try {
    const staffName = (await firstNames([staff._id])).get(staff._id) ?? "";
    await sendToRoles("foreignLookup", [COORDINATION_ROLE], { variables: { staff: staffName, count } });
  } catch (err) {
    console.error("notify: foreign lookup alert failed", err);
  }
}

// ── kids changing hands ───────────────────────────────────────────────────────

/** After a camper write (before / after; null on create / delete): the caretaker who lost the kid and the one who got it. */
export async function notifyCamperChange(before: Camper | null, after: Camper | null): Promise<void> {
  try {
    const from = before?.caretakerId ?? null;
    const to = after?.caretakerId ?? null;
    if (from === to) return;
    const settings = await getSettings();
    if (!settings.notifications.bedroomChanges || settings.kidsRoomsDraft) return;
    const kid = (after ?? before)!;
    const kidName = (await firstNames([kid._id])).get(kid._id) ?? "";
    const [lost, got] = await Promise.all([from ? findStaffById(from) : null, to ? findStaffById(to) : null]);
    if (lost?.active) enqueue("kidUnassigned", { personId: lost._id, variables: { kid: kidName } }, "staff");
    if (got?.active && after) enqueue("kidAssigned", { personId: got._id, variables: { kid: kidName, room: await bedroomName(after.bedroom) } }, "staff");
  } catch (err) {
    console.error("notify: camper change failed", err);
  }
}

/** Several kids changed hands at once (a caretaker moved rooms). */
export async function notifyCaretakerChange(kids: Camper[], from: Staff, to: Staff | null): Promise<void> {
  try {
    if (kids.length === 0) return;
    const settings = await getSettings();
    if (!settings.notifications.bedroomChanges || settings.kidsRoomsDraft) return;
    const names = joinNames([...(await firstNames(kids.map((k) => k._id))).values()]);
    if (from.active) enqueue("kidUnassigned", { personId: from._id, variables: { kid: names } }, "staff");
    if (to?.active) enqueue("kidAssigned", { personId: to._id, variables: { kid: names, room: await bedroomName(kids[0].bedroom) } }, "staff");
  } catch (err) {
    console.error("notify: caretaker change failed", err);
  }
}

// ── the person's own allocation ──────────────────────────────────────────────

/** After a team member update: their own room / room role / team / vehicle. */
export async function notifyStaffChange(before: Staff, after: Staff): Promise<void> {
  try {
    if (!after.active) return;
    const settings = await getSettings();
    if (!settings.notifications.staffChanges) return;
    const personId = after._id;
    if (before.bedroom !== after.bedroom && !settings.kidsRoomsDraft) enqueue("myRoom", { personId, variables: { room: await bedroomName(after.bedroom) } }, "staff");
    if (before.roomRole !== after.roomRole) enqueue(after.roomRole === "caretaker" ? "myRoomCaretaker" : "myRoomHelper", { personId }, "staff");
    if (before.team !== after.team) enqueue("myTeam", { personId, variables: { team: after.team ? ((await findTeamById(after.team))?.name ?? "—") : "—" } }, "staff");
    if (before.transportation !== after.transportation) enqueue("myBus", { personId, variables: { bus: await transportLabel(after.transportation) } }, "staff");
  } catch (err) {
    console.error("notify: staff change failed", err);
  }
}

// ── "montar quartos" applied ───────────────────────────────────────────────

/** One person's slice of the bulk room apply — which messages they get. */
export interface RoomsAppliedMessage {
  staffId: string;
  /** catalog keys + variables, in send order */
  messages: { key: TemplateKey; variables: Record<string, string> }[];
  /** pt-BR preview of the first message (the settings dialog shows it) */
  text: string;
}

/**
 * Pure core of notifyRoomsApplied: given before/after + settings + rooms,
 * who gets which message. Same gates as the individual writes (staffChanges /
 * bedroomChanges, the kids-rooms draft). `kidNames` maps kid ids to first names.
 */
export function roomsAppliedMessages(
  before: { staff: Staff[]; campers: Camper[] },
  after: { staff: Staff[]; campers: Camper[] },
  settings: Settings,
  rooms: Bedroom[],
  kidNames: Map<string, string> = new Map(),
): RoomsAppliedMessage[] {
  const out: RoomsAppliedMessage[] = [];
  const n = settings.notifications;
  if (!n.staffChanges && !n.bedroomChanges) return out;
  const roomName = (id: string | null) => (id ? (rooms.find((b) => b._id === id)?.name ?? "—") : "—");
  const beforeStaff = new Map(before.staff.map((s) => [s._id, s]));
  const kidsOf = (list: Camper[]) => {
    const m = new Map<string, Camper[]>();
    for (const k of list) if (k.caretakerId) m.set(k.caretakerId, [...(m.get(k.caretakerId) ?? []), k]);
    return m;
  };
  const kidsBeforeOf = kidsOf(before.campers);
  const kidsAfterOf = kidsOf(after.campers);
  for (const s of after.staff) {
    const was = beforeStaff.get(s._id);
    if (!was || !s.active) continue;
    const beforeIds = new Set((kidsBeforeOf.get(s._id) ?? []).map((k) => k._id));
    const kidsAfter = kidsAfterOf.get(s._id) ?? [];
    const gained = kidsAfter.filter((k) => !beforeIds.has(k._id));
    const messages: RoomsAppliedMessage["messages"] = [];
    if (was.bedroom !== s.bedroom && n.staffChanges && !settings.kidsRoomsDraft) messages.push({ key: "myRoom", variables: { room: roomName(s.bedroom) } });
    if (was.roomRole !== s.roomRole && n.staffChanges) messages.push({ key: s.roomRole === "caretaker" ? "myRoomCaretaker" : "myRoomHelper", variables: {} });
    if (gained.length && n.bedroomChanges && !settings.kidsRoomsDraft) {
      messages.push({ key: "kidAssigned", variables: { kid: joinNames(gained.map((k) => kidNames.get(k._id) ?? "")), room: roomName(s.bedroom) } });
    }
    if (messages.length === 0) continue;
    out.push({ staffId: s._id, messages, text: previewMessage(messages[0].key, messages[0].variables) });
  }
  return out;
}

export async function notifyRoomsApplied(before: { staff: Staff[]; campers: Camper[] }, after: { staff: Staff[]; campers: Camper[] }): Promise<void> {
  try {
    const settings = await getSettings();
    const rooms = await listBedrooms();
    const kidNames = await firstNames(after.campers.map((k) => k._id));
    for (const m of roomsAppliedMessages(before, after, settings, rooms, kidNames)) {
      for (const msg of m.messages) enqueue(msg.key, { personId: m.staffId, variables: msg.variables }, "staff");
    }
  } catch (err) {
    console.error("notify: rooms apply failed", err);
  }
}

// ── duties in the programme ─────────────────────────────────────────────────

interface Duty {
  roleId: string;
  detail: string;
}

function dutiesOf(e: CampEvent | null, staff: Staff[], roleById: Map<string, ScheduleRole>, teamById: Map<string, Team>): Map<string, Duty> {
  const out = new Map<string, Duty>();
  if (!e) return out;
  for (const s of staff) {
    const a = e.assignments.find((x) => x.staffId === s._id);
    if (a) out.set(s._id, { roleId: a.roleId, detail: assignmentDetail(roleById.get(a.roleId), a, s, teamById).detail });
    else if (s.active) {
      const auto = autoRoleFor(e, s.roomRole, roleById);
      if (auto) out.set(s._id, { roleId: auto._id, detail: "" });
    }
  }
  return out;
}

function eventLabel(e: CampEvent): string {
  const [, m, d] = e.date.split("-");
  return `${e.title} (${d}/${m} ${e.startTime})`;
}

/** After an event write (before / after; null on create / delete): whose duty changed, or everyone with a duty when it moved. */
export async function notifyEventChange(before: CampEvent | null, after: CampEvent | null): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.roleChanges) return;
    const [staff, roles, teams] = await Promise.all([listStaff(), listRoles(), listTeams()]);
    const roleById = new Map(roles.map((r) => [r._id, r]));
    const teamById = teamMap(teams);
    const prev = dutiesOf(before, staff, roleById, teamById);
    const next = dutiesOf(after, staff, roleById, teamById);
    const moved = !!before && !!after && (before.date !== after.date || before.startTime !== after.startTime || before.endTime !== after.endTime);
    const duty = (d: Duty) => [roleById.get(d.roleId)?.name ?? "", d.detail].filter(Boolean).join(" · ");
    for (const s of staff) {
      const a = prev.get(s._id);
      const b = next.get(s._id);
      if (b && (!a || a.roleId !== b.roleId || a.detail !== b.detail)) enqueue("roleAssigned", { personId: s._id, variables: { event: eventLabel(after!), duty: duty(b) } }, "staff");
      else if (a && !b && !after) enqueue("eventCancelled", { personId: s._id, variables: { event: eventLabel(before!) } }, "staff");
      else if (a && !b) enqueue("roleRemoved", { personId: s._id, variables: { event: eventLabel(after ?? before!) } }, "staff");
      else if (b && moved) enqueue("eventMoved", { personId: s._id, variables: { event: before!.title, when: eventLabel(after!) } }, "staff");
    }
  } catch (err) {
    console.error("notify: event change failed", err);
  }
}

/** A função was edited → everyone who does it (instructions / preparation text changes). */
export async function notifyRoleEdited(roleBefore: ScheduleRole, roleAfter: ScheduleRole, events: CampEvent[]): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.contentChanges) return;
    const instructions = roleBefore.instructions !== roleAfter.instructions;
    const preparation = roleBefore.preparation !== roleAfter.preparation;
    if (!instructions && !preparation) return;
    const using = events.filter((e) => e.roles.includes(roleAfter._id));
    for (const s of await listStaff({ active: true })) {
      const concerned = using.some((e) => {
        const a = e.assignments.find((x) => x.staffId === s._id);
        return a ? a.roleId === roleAfter._id : autoRoleCovers(roleAfter, s.roomRole) || autoRoleCovers(roleBefore, s.roomRole);
      });
      if (!concerned) continue;
      if (instructions) enqueue("instructionsUpdated", { personId: s._id, variables: { title: roleAfter.name } }, "staff");
      if (preparation) enqueue("preparationUpdated", { personId: s._id, variables: { title: roleAfter.name } }, "staff");
    }
  } catch (err) {
    console.error("notify: role edit failed", err);
  }
}

// ── general documents ───────────────────────────────────────────────────────

/** The whole active team (or only caretakers / helpers). */
async function teamFor(audience: DocAudience | RoomRole | "all"): Promise<Staff[]> {
  return (await listStaff({ active: true })).filter((s) => audience === "all" || s.roomRole === audience);
}

/** An Instruções document was created or its title / content changed. */
export async function notifyInstructionChange(before: InstructionDoc | null, after: InstructionDoc): Promise<void> {
  try {
    if (before && before.title === after.title && before.content === after.content) return;
    if (!(await getSettings()).notifications.contentChanges) return;
    for (const s of await teamFor(after.audience)) enqueue("instructionsUpdated", { personId: s._id, variables: { title: after.title } }, "staff");
  } catch (err) {
    console.error("notify: instruction change failed", err);
  }
}

/** A Preparação section was created / changed / posted to a new group. Parents only inside their access window. */
export async function notifyPreparationChange(before: PrepSection | null, after: PrepSection): Promise<void> {
  try {
    const changed = !before || before.title !== after.title || before.content !== after.content;
    const gained = (a: PrepAudience) => after.audiences.includes(a) && (!before || !before.audiences.includes(a));
    const concerned = (a: PrepAudience) => after.audiences.includes(a) && (changed || gained(a));
    if (!PREP_AUDIENCES.some(concerned)) return;
    const n = (await getSettings()).notifications;
    if (n.contentChanges && (concerned("caretaker") || concerned("helper"))) {
      for (const s of await teamFor("all")) if (concerned(s.roomRole)) enqueue("preparationUpdated", { personId: s._id, variables: { title: after.title } }, "staff");
    }
    if (n.parentContentChanges && concerned("parent") && staffAccessOpen((await getSettings()).parentAccessWindow)) {
      await sendToRoles("preparationUpdated", [RESPONSIBLE_ROLE], { variables: { title: after.title } });
    }
  } catch (err) {
    console.error("notify: preparation change failed", err);
  }
}

/** Photos were published: every team member and family, ONCE per camp. */
export async function notifyPhotosPublished(count: number): Promise<void> {
  try {
    if (count <= 0) return;
    const settings = await getSettings();
    if (!settings.notifications.photoPublishes) return;
    for (const s of await listStaff({ active: true })) {
      if (await claimStaffPhotosNotice(s._id)) enqueue("photosPublished", { personId: s._id }, "staff");
    }
    if (staffAccessOpen(settings.parentAccessWindow) && (await claimUserPhotosNotice(FAMILIES_MARK))) {
      if ((await sendToRoles("photosPublished", [RESPONSIBLE_ROLE])) === null) await resetUserPhotosNoticeOf(FAMILIES_MARK);
    }
  } catch (err) {
    console.error("notify: photos published failed", err);
  }
}

// ── families: the kid boarded the bus ─────────────────────────────────────────

export async function notifyBusCheckin(kid: Camper): Promise<void> {
  try {
    if (!(await getSettings()).notifications.busCheckin) return;
    const parents = (await responsiblesOf([kid._id])).get(kid._id) ?? [];
    const kidName = (await firstNames([kid._id])).get(kid._id) ?? "";
    await sendMessage("busBoarded", parents.map((personId) => ({ personId, variables: { kid: kidName } })));
  } catch (err) {
    console.error("notify: bus checkin failed", err);
  }
}

// ── welcomes ─────────────────────────────────────────────────────────────────

/**
 * Families who joined after the edition's welcome went out (a registration, an accepted link request, an import):
 * welcomed by id, once per camp each. Before that audience send they are simply part of it.
 */
export async function welcomeLateFamilies(personIds: string[]): Promise<void> {
  try {
    const ids = [...new Set(personIds.filter(Boolean))];
    if (ids.length === 0) return;
    const settings = await getSettings();
    if (!settings.notifications.parentWelcome || !staffAccessOpen(settings.parentAccessWindow)) return;
    if (!(await findUserCampState(FAMILIES_MARK))?.welcomeSentAt) return;
    const fresh: string[] = [];
    for (const id of ids) if (await claimUserWelcome(id)) fresh.push(id);
    if (fresh.length) await sendMessage("parentWelcome", fresh.map((personId) => ({ personId })));
  } catch (err) {
    console.error("notify: late family welcome failed", err);
  }
}

/** When the parents' access window is open, the families of the edition get the welcome (role audience, once per camp). */
export async function syncParentWelcomes(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.parentWelcome || !staffAccessOpen(settings.parentAccessWindow)) return;
    if (!(await claimUserWelcome(FAMILIES_MARK))) return;
    if ((await sendToRoles("parentWelcome", [RESPONSIBLE_ROLE])) === null) await resetUserWelcomeOf(FAMILIES_MARK);
  } catch (err) {
    console.error("notify: parent welcome sync failed", err);
  }
}

/** When the team window is open, every active team member not welcomed yet gets the welcome (once ever per camp). */
export async function syncWelcomes(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.enrolments || !staffAccessOpen(settings.staffAccessWindow)) return;
    for (const s of await listStaff({ active: true })) {
      if (s.welcomeSentAt) continue;
      if (await claimStaffWelcome(s._id)) await sendMessage("teamWelcome", [{ personId: s._id }]);
    }
  } catch (err) {
    console.error("notify: welcome sync failed", err);
  }
}

/**
 * Who WOULD be welcomed right now (settings preview) — counts and person ids (names read by the client). The
 * families are the edition's responsáveis as the viewer (coordenação) may list them, until their welcome went out.
 */
export async function welcomePreview(): Promise<{ staff: { count: number; windowOpen: boolean; personIds: string[] }; parents: { count: number; windowOpen: boolean; personIds: string[] } }> {
  const settings = await getSettings();
  const staffOpen = staffAccessOpen(settings.staffAccessWindow);
  const team = (await listStaff({ active: true })).filter((s) => !s.welcomeSentAt).map((s) => s._id);
  const parentsOpen = staffAccessOpen(settings.parentAccessWindow);
  const welcomed = !!(await findUserCampState(FAMILIES_MARK))?.welcomeSentAt;
  const parents = parentsOpen && !welcomed ? [...new Set((await membersOf(RESPONSIBLE_ROLE)).map((m) => m.personId))] : [];
  return {
    staff: { count: staffOpen ? team.length : 0, windowOpen: staffOpen, personIds: staffOpen ? team : [] },
    parents: { count: parents.length, windowOpen: parentsOpen, personIds: parents },
  };
}
