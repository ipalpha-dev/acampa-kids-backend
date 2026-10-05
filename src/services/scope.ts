import { listCampers } from "../models/campers";
import { listEvents } from "../models/schedule";
import { checkinWindowOpen, getSettings, scoreHidden, staffAccessOpen } from "../models/settings";
import { findStaffById } from "../models/staff";
import { findUserCampState } from "../models/userCampState";
import { COORDINATION_ROLE, type CampEvent, type Camper, type CoreRole, type DocAudience, type OccurrenceGroup, type PrepAudience, type Role, type RoomRole, type ScheduleRole, type Settings, type Staff } from "../types";
import { campInProgress, campPeriod, parentWindowOf, parentWindowOpen, vestWindowOpen } from "./camp";
import { kidsOfResponsible } from "./members";
import { autoRoleCovers } from "./schedule";

/**
 * Data scope of a session — the ONE place that decides what a non-admin may
 * read. Every read path (REST lists/details and the realtime snapshot) filters
 * through here, so the frontend never receives what it must not show.
 *
 *   coordenacao  → everything (`admin` audience; project-wide role, every edition)
 *   staff /      → only their own room. A CARETAKER (staff.roomRole) gets the
 *   health_staff   kids under THEIR care (Camper.caretakerId) any time, and the
 *                  other kids of the room only WHILE THE CAMP IS HAPPENING
 *                  (see services/camp.ts); a HELPER gets the room's kids only
 *                  during the camp. Both as "care" records: health, notes,
 *                  preferences and the guardian's NAME + PHONE (so they can
 *                  reach the parents), but NO emergency contact, documents,
 *                  insurance or e-mail (that stays with the admin, the medical
 *                  team and the check-in helpers). Plus their own staff record
 *                  and the NAME + PHONE + room role + TEAM of the colleagues
 *                  in the same room.
 *                  The programme: every event, but only the roles that apply
 *                  to THEM (see scopeEvent) — never who does what elsewhere.
 *   check-in     → role `checkin`, WHILE
 *   helper         the check-in window is open: additionally every camper
 *                  (full record, health included — they confirm it with the
 *                  parents) and every bedroom. Other staff stay invisible.
 *                  The moment the window closes the extra data stops being
 *                  sent (snapshot, updates and REST alike).
 *   bus helper   → role `checkin-onibus`, same window. The coordenação links the
 *                  helper to ONE vehicle (Settings → busHelpers, independent
 *                  from staff.transportation: they stand at the DOOR of that
 *                  vehicle, they need not ride in it). They get the campers of
 *                  THAT vehicle as NAME-ONLY records (name, age, room, team,
 *                  check-in stamps) — never health, contacts or notes — plus
 *                  every bedroom (for the labels). Kids in their own room stay
 *                  full (they look after them).
 *   organizer    → role `organizacao` (no time
 *                  window): the ADMIN'S data scope (`all: true`) — every
 *                  camper, staff member, bedroom and the whole programme —
 *                  and the admin's writes, EXCEPT the four admin-only areas:
 *                  the organizers list itself, categories, notifications and
 *                  the "about" page (`admin: false`). Occurrences: only the
 *                  ones the organizers themselves registered (the admin sees all).
 *   game         → role `organizacao-jogos` (no
 *   organizer      window): writes the programme (events, roles, assignments)
 *                  and the scoreboard (Placar): give / take / zero points of
 *                  any team. Sees every staff member in FULL and the whole
 *                  programme. NOT an organizer: campers / bedrooms as any team
 *                  member, no settings.
 *   score helper → role `pontuacao` (no
 *                  window): ONLY the bulk QR scan tied to a programme event
 *                  (the kid's team gets the event's points). Never gives /
 *                  takes points by team, never zeroes, deletes only their
 *                  own scan lines, no organizer rights. Every camper reaches
 *                  them as a "name" record (name + team) so the scan can be
 *                  resolved and shown. Everything else: as any team member.
 *   medical      → role `saude` (no time
 *                  window): every camper in FULL (health included), every
 *                  bedroom — hence every vehicle — the whole time. They may
 *                  edit the kids' HEALTH block (PUT /api/campers/:id/health),
 *                  never rooms or check-ins. Occurrences: only the ones the
 *                  medical team registered. Staff / programme: as any team
 *                  member.
 *   vest helper  → role `coletes`,
 *                  until VEST_GRACE_DAYS after the camp ends (they collect the
 *                  vests back in the days after): every staff member as NAME + PHONE +
 *                  vest status ("contact" visibility) — never health, room,
 *                  team or check-in — and may stamp the vest delivery /
 *                  return. Everything else: as any team member.
 *   photographer → role `fotografia` (no
 *   window): uploads the camp's photos (POST /api/gallery), edits and
 *   publishes them, and sees the drafts on the Fotos tab. Everything else:
 *   as any team member.
 *   parent       → role `responsavel`: their OWN kids (participante memberships naming them as involved), in full,
 *                  and the kids' rooms. The "important contacts"
 *                  (Settings → Contatos) as NAME + PHONE records the WHOLE
 *                  time the parent may use the app (their access window —
 *                  they are the numbers to call when something happens).
 *                  WHILE THE PARENTS' WINDOW is open (from the kids' check-in
 *                  start to the end of the last event — see
 *                  services/camp.ts#parentWindow) additionally the team
 *                  members of their kids' rooms, same NAME + PHONE shape.
 *                  Outside it: the contacts only. The programme: events
 *                  marked visible to parents, without roles or assignments.
 *                  They may edit their kid's health block
 *                  (PUT /api/campers/:id/parent).
 *
 * The scope follows the ACTING role only (role switch = another scope). Health
 * itself is read from persons-api with the acting role token, so core's role
 * rules have the last word; this scope decides camp-ops visibility.
 *
 * ORDINARY team members (role `equipe`, not a parent contact)
 * are further gated by `settings.staffAccessWindow`: outside it they get
 * NO_ACCESS. `settings.checkinTestMode` makes the check-in window count as
 * open for the church / bus helpers (testing before the real day).
 */
export interface Viewer {
  /** the audience of the acting role (admin on a history session) */
  activeRole: Role;
  /** the acting IPAlpha project role (§10) */
  coreRole: CoreRole;
  /** the IPAlpha person id — how the session is matched to a participant row */
  personId: string;
}

/**
 * §10 role keys → what the role adds on top of an ordinary team member.
 * Roles are per edition and live in projects-api; the WINDOWS (check-in,
 * bus trips, vests, staff / parent access) stay camp ops in settings.
 */
export const ROLE_FLAGS: Record<string, "organizer" | "gameOrganizer" | "scoreHelper" | "medical" | "vestHelper" | "photographer" | "checkinHelper" | "busHelper" | "team"> = {
  organizacao: "organizer",
  "organizacao-jogos": "gameOrganizer",
  pontuacao: "scoreHelper",
  saude: "medical",
  coletes: "vestHelper",
  fotografia: "photographer",
  checkin: "checkinHelper",
  "checkin-onibus": "busHelper",
  equipe: "team",
};

export type Scope =
  | {
      all: true;
      /** true for the real admin session; false for an ORGANIZER (same data, minus the admin-only settings) */
      admin: boolean;
    }
  | {
      all: false;
      /** the viewer's own team row (= person id; null when not on this camp's team) */
      staffId: string | null;
      /** the viewer's bedroom id (null when unassigned) */
      bedroom: string | null;
      /** true while this person is a listed CHURCH check-in helper AND that window is open */
      checkinHelper: boolean;
      /** the vehicle (transportation option id) linked to this BUS helper while either trip window is open; null otherwise */
      busHelperVehicle: string | null;
      /** may record the outbound bus roll call right now */
      busOutboundHelper: boolean;
      /** may record the return bus roll call right now */
      busReturnHelper: boolean;
      /** true when this person may write the PROGRAMME (events, roles, assignments) and sees the whole team: game organizers (real organizers get `all: true` instead) */
      organizer: boolean;
      /** true when this person is a listed GAME organizer (no window): programme + writes the scoreboard */
      gameOrganizer: boolean;
      /** true when this person is a listed SCORE helper (no window): bulk QR scan by event only — no per-team points, no zero, no organizer rights */
      scoreHelper: boolean;
      /** true when this person is on the MEDICAL team (no window): every camper + bedroom in full, and may edit the kids' health block */
      medical: boolean;
      /** true when this person hands out / takes back the team VESTS — listed AND before / during / up to VEST_GRACE_DAYS after the camp: every staff member as name + phone */
      vestHelper: boolean;
      /** true when this person is a listed PHOTOGRAPHER (no window): uploads, edits and publishes the camp's photos */
      photographer: boolean;
      /** true while the kids' room allocation is still a draft (Settings → Geral): the viewer's OWN room shows no kids */
      kidsRoomsDraft: boolean;
      /** true while the camp is happening (first → last programme day): the whole room's kids become visible */
      campActive: boolean;
      /** the viewer's role in their room — decides which general documents (Instruções / Preparação) they get */
      roomRole: RoomRole;
      /** PARENT session: the ids of their own kids (empty for every other role) */
      parentKids: string[];
      /** PARENT session: the rooms of those kids */
      parentBedrooms: string[];
      /** PARENT session: true while the parents' window is open — the team of their kids' ROOMS is sent (name + phone) */
      parentRoomStaff: boolean;
      /** PARENT session: person ids listed as important contacts (Settings → Contatos) — sent the whole time the parent has access */
      parentContactIds: string[];
      /** PARENT session: the Preparação items they ticked as done ("section:<id>" — userCampState) */
      parentPrepDone: string[];
    };

export const NO_ACCESS: Extract<Scope, { all: false }> = { all: false, staffId: null, bedroom: null, checkinHelper: false, busHelperVehicle: null, busOutboundHelper: false, busReturnHelper: false, organizer: false, gameOrganizer: false, scoreHelper: false, medical: false, vestHelper: false, photographer: false, kidsRoomsDraft: false, campActive: false, roomRole: "helper", parentKids: [], parentBedrooms: [], parentRoomStaff: false, parentContactIds: [], parentPrepDone: [] };

/** Is this a PARENT session with at least one kid enrolled? */
export function isParent(scope: Scope): boolean {
  return !scope.all && scope.parentKids.length > 0;
}

/** the parent branch of a scope (only meaningful when `isParent(scope)`) */
function asParent(scope: Scope): Extract<Scope, { all: false }> {
  return scope as Extract<Scope, { all: false }>;
}

/**
 * A KNOWN helper role (a ROLE_FLAGS key other than `equipe`) or the
 * coordenação, or a person listed as a parent contact: never gated by the
 * staff access window. An unknown role key (a future helper core already
 * grants, without a flag here yet) behaves EXACTLY as `equipe` — window
 * included; `responsavel` has its own window.
 */
export function isPrivilegedStaff(personId: string, coreRole: CoreRole, s: Settings): boolean {
  if (coreRole === COORDINATION_ROLE) return true;
  const flag = Object.hasOwn(ROLE_FLAGS, coreRole) ? ROLE_FLAGS[coreRole] : undefined;
  return (flag !== undefined && flag !== "team") || s.parentContacts.some((p) => p.personId === personId);
}

/** May this team member use the app (and be notified) right now? Ordinary members only inside `staffAccessWindow`. */
export function staffHasAccess(personId: string, coreRole: CoreRole, s: Settings, now = new Date()): boolean {
  return isPrivilegedStaff(personId, coreRole, s) || staffAccessOpen(s.staffAccessWindow, now);
}

/**
 * The parent's scope: their kids (the `participante` memberships naming them
 * as involved responsável, ∩ this camp's kids), the kids' rooms, the important
 * contacts (always) and, inside the parents' window, the team of those rooms.
 */
async function resolveParentScope(personId: string): Promise<Scope> {
  const kidIds = await kidsOfResponsible(personId);
  if (kidIds.length === 0) return NO_ACCESS;
  const [kids, settings, events, state] = await Promise.all([listCampers({ personIds: kidIds }), getSettings(), listEvents(), findUserCampState(personId)]);
  if (kids.length === 0) return NO_ACCESS;
  const open = parentWindowOpen(parentWindowOf(settings, events));
  return {
    ...NO_ACCESS,
    kidsRoomsDraft: settings.kidsRoomsDraft,
    parentKids: kids.map((k) => k._id),
    parentBedrooms: settings.kidsRoomsDraft ? [] : [...new Set(kids.map((k) => k.bedroom).filter((b): b is string => !!b))],
    parentRoomStaff: open,
    parentContactIds: settings.parentContacts.map((p) => p.personId),
    parentPrepDone: state?.prepDone ?? [],
  };
}

export const ADMIN: Extract<Scope, { all: true }> = { all: true, admin: true };
export const ORGANIZER: Extract<Scope, { all: true }> = { all: true, admin: false };

/**
 * The scope of the ACTING role (§10 → flags). A helper role keeps the
 * person's own team row (room, room role) when they are on this camp's team.
 */
export async function resolveScope(viewer: Viewer): Promise<Scope> {
  if (viewer.activeRole === "admin") return ADMIN;
  if (viewer.activeRole === "parent") return resolveParentScope(viewer.personId);
  if (viewer.coreRole === COORDINATION_ROLE) return ADMIN;
  const flag = Object.hasOwn(ROLE_FLAGS, viewer.coreRole) ? ROLE_FLAGS[viewer.coreRole] : "team";
  const [me, settings] = await Promise.all([findStaffById(viewer.personId), getSettings()]);
  // a plain team member must be on this camp's (active) team; a helper role works without a room
  if (flag === "team" && (!me || !me.active)) return NO_ACCESS;
  if (me && !me.active && flag !== "team") return NO_ACCESS;
  // ORDINARY team members only get in during the staff access window
  if (!staffHasAccess(viewer.personId, viewer.coreRole, settings)) return NO_ACCESS;
  if (flag === "organizer") return ORGANIZER;
  const { checkinWindow, busReturnWindow, checkinTestMode, busHelpers, kidsRoomsDraft } = settings;
  const period = await campPeriod();
  const gameOrganizer = flag === "gameOrganizer";
  const linkedVehicle = flag === "busHelper" ? (busHelpers.helpers.find((h) => h.personId === viewer.personId)?.vehicleId ?? null) : null;
  // test mode opens every kids' roll call; bus helpers stay active in either trip's window
  const departureWindowOpen = checkinTestMode || checkinWindowOpen(checkinWindow);
  const busWindowOpen = departureWindowOpen || checkinWindowOpen(busReturnWindow);
  return {
    ...NO_ACCESS,
    staffId: me?._id ?? null,
    bedroom: me?.bedroom ?? null,
    checkinHelper: flag === "checkinHelper" && departureWindowOpen,
    busHelperVehicle: busWindowOpen ? linkedVehicle : null,
    busOutboundHelper: linkedVehicle !== null && departureWindowOpen,
    busReturnHelper: linkedVehicle !== null && (checkinTestMode || checkinWindowOpen(busReturnWindow)),
    organizer: gameOrganizer,
    gameOrganizer,
    scoreHelper: flag === "scoreHelper",
    medical: flag === "medical",
    // the vest helper keeps the tab for a few days after the camp (vests come back then), not forever
    vestHelper: flag === "vestHelper" && vestWindowOpen(period),
    photographer: flag === "photographer",
    kidsRoomsDraft,
    campActive: campInProgress(period),
    roomRole: me?.roomRole ?? "helper",
  };
}

/** The Preparação items this session has already ticked (parents; the team's live on their staff record). */
export function prepDoneOf(scope: Scope): string[] {
  return isParent(scope) ? asParent(scope).parentPrepDone : [];
}

/** May this PARENT session edit `k`'s "Informações de saúde"? (their own kid) */
export function canParentEdit(scope: Scope, k: Pick<Camper, "_id">): boolean {
  return isParent(scope) && asParent(scope).parentKids.includes(k._id);
}

/** A general Instruções document reaches everyone, or only the caretakers / helpers. Admins and organizers see all. */
export function canSeeDoc(scope: Scope, d: { audience: DocAudience }): boolean {
  if (scope.all || scope.organizer) return true;
  return d.audience === "all" || d.audience === scope.roomRole;
}

/**
 * A Preparação section is posted to one or more groups: parents see only the
 * sections posted to `parent`; a team member sees the ones posted to their room
 * role. Admins and organizers see all.
 */
export function canSeePrep(scope: Scope, s: { audiences: PrepAudience[] }): boolean {
  if (scope.all || scope.organizer) return true;
  if (isParent(scope)) return s.audiences.includes("parent");
  return s.audiences.includes(scope.roomRole);
}

/** May this session do what the admin does (campers, staff, rooms, check-ins, documents, most settings)? (admin or organizer) */
export function canManage(scope: Scope): boolean {
  return scope.all;
}

/** Which occurrence group this session belongs to (null = cannot see / create). */
export function viewerOccurrenceGroup(scope: Scope): OccurrenceGroup | null {
  if (scope.all) return scope.admin ? "admin" : "organizer";
  return scope.medical ? "medical" : null;
}

/** Is this the real admin? (organizers list, categories, notifications, about) */
export function isAdmin(scope: Scope): boolean {
  return scope.all && scope.admin;
}

/** May this session write the scoreboard (give / take / zero points, delete any line)? (admin, organizer or game organizer) */
export function canKeepScore(scope: Scope): boolean {
  return scope.all || scope.gameOrganizer;
}

/** May this session run the bulk QR scan (points by event)? (scorekeepers + score helpers) */
export function canLaunchScore(scope: Scope): boolean {
  return scope.all || scope.gameOrganizer || scope.scoreHelper;
}

/**
 * May this session read the scoreboard ledger right now? Whoever launches
 * points (admin, organizers, game organizers, score helpers) always does;
 * everyone else loses it while the suspense window (`scoreHideWindow`) is on.
 */
export function canSeeScores(scope: Scope, s: Pick<Settings, "scoreHideWindow">, now = new Date()): boolean {
  return canLaunchScore(scope) || !scoreHidden(s.scoreHideWindow, now);
}

/** May this session hand out / take back the team vests? (admin, organizer or vest helper) */
export function canHandleVests(scope: Scope): boolean {
  return scope.all || scope.vestHelper;
}

/** May this session upload / edit / publish the camp's photos? (admin or photographer) */
export function canManageGallery(scope: Scope): boolean {
  return scope.all || scope.photographer;
}

/** May this session write the programme (events, roles, assignments)? (admin, organizer or game organizer) */
export function canOrganize(scope: Scope): boolean {
  return scope.all || scope.organizer;
}

/** May this session run the kids' CHURCH check-in right now? (admin, or a church helper inside the window) */
export function canRunCheckin(scope: Scope): boolean {
  return scope.all || scope.checkinHelper;
}

/** May this session roll-call `k` on this bus trip right now? */
export function canRunBusCheckin(scope: Scope, k: Pick<Camper, "transportation">, kind: "bus" | "bus_return"): boolean {
  if (scope.all) return true;
  const tripOpen = kind === "bus" ? scope.busOutboundHelper : scope.busReturnHelper;
  return tripOpen && scope.busHelperVehicle !== null && k.transportation === scope.busHelperVehicle;
}

export function canSeeBedroom(scope: Scope, bedroomId: string): boolean {
  if (isParent(scope)) return asParent(scope).parentBedrooms.includes(bedroomId);
  return scope.all || scope.medical || scope.checkinHelper || scope.busHelperVehicle !== null || (!scope.kidsRoomsDraft && scope.bedroom !== null && scope.bedroom === bedroomId);
}

/**
 * "full" = whole record, "care" = what a room caretaker / helper needs (health,
 * notes, preferences, guardian name + phone — no emergency / documents), "name" = roll-call
 * view (no health / contacts / notes), "none" = invisible.
 */
export type CamperVisibility = "full" | "care" | "name" | "none";

export function camperVisibility(scope: Scope, k: Pick<Camper, "_id" | "bedroom" | "transportation" | "caretakerId">): CamperVisibility {
  if (scope.all || scope.medical || scope.checkinHelper) return "full";
  // a parent: their own kids, nothing else
  if (isParent(scope)) return asParent(scope).parentKids.includes(k._id) ? "full" : "none";
  if (!scope.kidsRoomsDraft && scope.staffId !== null) {
    // the kids under my care: any time
    if (k.caretakerId === scope.staffId) return "care";
    // the rest of my room: only while the camp is happening
    if (scope.campActive && k.bedroom !== null && k.bedroom === scope.bedroom) return "care";
  }
  // a bus helper works the door of ONE vehicle: its kids, names only
  if (scope.busHelperVehicle !== null && k.transportation === scope.busHelperVehicle) return "name";
  // a score helper scans any kid at the door: name + team, nothing else
  return scope.scoreHelper ? "name" : "none";
}

export function canSeeCamper(scope: Scope, k: Pick<Camper, "_id" | "bedroom" | "transportation" | "caretakerId">): boolean {
  return camperVisibility(scope, k) !== "none";
}

/**
 * "full" = whole record, "contact" = name + phone + room role (a colleague in
 * the same room, a parent's contact, or everyone for the vest helper — who also
 * gets the vest status), "none" = invisible.
 */
export type StaffVisibility = "full" | "contact" | "none";

export function staffVisibility(scope: Scope, s: Pick<Staff, "_id" | "bedroom" | "active">): StaffVisibility {
  if (scope.all || scope.organizer) return "full";
  // a parent: the important contacts the whole time; the team of their kids' rooms only inside the parents' window. Name + phone either way.
  if (isParent(scope)) {
    if (!s.active) return "none";
    if (scope.parentContactIds.includes(s._id)) return "contact";
    return scope.parentRoomStaff && s.bedroom !== null && scope.parentBedrooms.includes(s.bedroom) ? "contact" : "none";
  }
  if (scope.staffId === s._id) return "full";
  // the vest helper reaches everyone by phone, and nothing more
  if (scope.vestHelper) return "contact";
  // roommates (name + phone + room role) are unknown while the rooms are still a draft
  if (!scope.kidsRoomsDraft && scope.bedroom !== null && s.bedroom === scope.bedroom) return "contact";
  return "none";
}

/** While the rooms are a draft the viewer must not learn their OWN room either (admins / organizers excepted). */
export function hideOwnBedroom(scope: Scope): boolean {
  return !scope.all && !scope.organizer && scope.kidsRoomsDraft;
}

/**
 * What a non-admin sees of an event: the event itself (everyone may know the
 * programme) with `roles` cut down to the ones that concern the viewer —
 * their explicit assignment, or the funções that fall on their POSITION
 * (`ScheduleRole.forRoomRoles`) when nobody escalou them — and `assignments`
 * reduced to their own entry. Other people's roles and names never leave the
 * server.
 */
export function scopeEvent(scope: Scope, e: CampEvent, roleById: Map<string, ScheduleRole>): CampEvent {
  if (scope.all || scope.organizer) return e;
  // parents see the programme, never who does what
  if (isParent(scope)) return { ...e, roles: [], assignments: [] };
  const mine = scope.staffId ? e.assignments.find((a) => a.staffId === scope.staffId) : undefined;
  const roles = mine ? e.roles.filter((id) => id === mine.roleId) : e.roles.filter((id) => autoRoleCovers(roleById.get(id), scope.roomRole));
  return { ...e, roles, assignments: mine ? [mine] : [] };
}

/** Roles a non-admin may know about: only the ones left in their scoped events. */
export function scopeRoles(scope: Scope, roles: ScheduleRole[], scopedEvents: CampEvent[]): ScheduleRole[] {
  if (scope.all || scope.organizer) return roles;
  const used = new Set(scopedEvents.flatMap((e) => e.roles));
  return roles.filter((r) => used.has(r._id));
}
