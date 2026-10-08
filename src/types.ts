/**
 * Acampa AUDIENCES — what a session looks like to the camp-ops code: the
 * coordenação (admin), a team member with some helper role (staff) or a
 * parent. The role itself comes from IPAlpha (`CoreRole`, CONTRACTS §10);
 * `audienceOf` maps one onto the other.
 */
export const ROLES = ["parent", "staff", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * The Acampa project's role keys in projects-api (CONTRACTS §10). Per edition
 * except `coordenacao` (project-wide, sees every edition). `participante` never
 * signs in. Future helpers are new keys: unknown keys behave as `equipe`.
 */
export const CORE_ROLES = ["coordenacao", "organizacao", "organizacao-jogos", "pontuacao", "saude", "coletes", "fotografia", "checkin", "checkin-onibus", "equipe", "responsavel"] as const;
export type CoreRole = (typeof CORE_ROLES)[number] | (string & {});
export const PARTICIPANT_ROLE = "participante";
export const RESPONSIBLE_ROLE = "responsavel";
export const TEAM_ROLE = "equipe";
export const COORDINATION_ROLE = "coordenacao";

/** The audience a core role lands on. */
export function audienceOf(role: CoreRole): Role {
  if (role === COORDINATION_ROLE) return "admin";
  if (role === RESPONSIBLE_ROLE) return "parent";
  return "staff";
}

/** UI language — the device's (the session keeps nothing about the person). */
export type AppLocale = "pt" | "en" | "es" | "fr" | "de";

/**
 * Who is behind a request: an IPAlpha person id + the roles of this session.
 * No name, phone or e-mail is kept (names are read live from core when shown).
 */
export interface SessionUser {
  /** the IPAlpha person id (also `personId`, kept as `id` for the many `byPersonId: user.id` stamps) */
  id: string;
  personId: string;
  /** every live project role of the person at login (the profile chooser) */
  roles: CoreRole[];
  /** the role the session acts as */
  coreRole: CoreRole;
  /** the audience of `coreRole` (forced to admin on a history session) */
  activeRole: Role;
  /** SUPER_ADMIN_PERSON_IDS member (deployment owner) */
  superAdmin: boolean;
}

// ── Categories (admin-managed enumerations) ──────────────────────────────

/** Who a category applies to: campers (kids), staff members, or both. */
export const CATEGORY_AUDIENCES = ["camper", "staff"] as const;
export type CategoryAudience = (typeof CATEGORY_AUDIENCES)[number];

/** Whether a person picks ONE option (team) or MANY (allergies). */
export const CATEGORY_SELECTIONS = ["single", "multiple"] as const;
export type CategorySelection = (typeof CATEGORY_SELECTIONS)[number];

export interface CategoryOption {
  id: string;
  label: string;
  order: number;
  /** inactive options are hidden from forms but kept for existing records */
  active: boolean;
  /** import dry-run option; hidden until the import is applied */
  draft?: boolean;
  importId?: string;
}

/**
 * A category is ALWAYS an enumeration: the admin defines the closed list of
 * options (e.g. teams, transport, bunk position) and camper/staff forms pick
 * from it — never a free-text field.
 */
export interface Category {
  _id: string;
  /** stable slug used by forms to reference the category (never changes on rename) */
  key: string;
  name: string;
  emoji: string;
  description?: string;
  appliesTo: CategoryAudience[];
  selection: CategorySelection;
  options: CategoryOption[];
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

// ── Transports (meios de transporte) ────────────────────────────────

/** How a group reaches the camp: a chartered BUS (has a colour + number) or a CAR. */
export const TRANSPORT_KINDS = ["bus", "car"] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

/**
 * The named bus colours. The name is a PREFIX of the bus label ("Ônibus Azul
 * 2") and the hex tints the bus logo. Kept as an ordered list so the picker
 * and the migration can iterate it; `hex` is what is stored on the vehicle.
 */
export const BUS_COLORS = [
  { name: "Verde", hex: "#0f9a8a" },
  { name: "Laranja", hex: "#f2843b" },
  { name: "Amarelo", hex: "#f4c430" },
  { name: "Vermelho", hex: "#e8503a" },
  { name: "Azul", hex: "#3b6ff2" },
  { name: "Roxo", hex: "#7d3bf2" },
  { name: "Verde-escuro", hex: "#2fae60" },
  { name: "Cinza", hex: "#444b52" },
] as const;

/** The name of a bus colour ("Azul"), or null for a custom/unknown hex. */
export function busColorName(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const h = hex.toLowerCase();
  return BUS_COLORS.find((c) => c.hex === h)?.name ?? null;
}

/**
 * A single vehicle. Lives in its OWN collection (not a category option) so a
 * bus can carry a colour and a number, and cars stay distinct from buses.
 * A BUS has no name — its label is derived from the number + colour (see
 * `transportLabel`); only a CAR carries a free-text `name` ("Carro do João").
 */
export interface Transport {
  _id: string;
  /** import dry-run document; normal lists hide it until apply */
  draft?: boolean;
  importId?: string;
  kind: TransportKind;
  /** cars only: free-text name ("Carro do João"); undefined for buses */
  name?: string;
  /** buses only: a hex colour ("#0f9a8a"); undefined for cars */
  color?: string;
  /** buses only: the vehicle number ("1", "2"…); undefined for cars */
  number?: string;
  /** buses only: how many seats the bus has; undefined when unknown / cars */
  capacity?: number;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

// ── Bedrooms (quartos) ──────────────────────────────────────────────

/** Which wing a bedroom belongs to — drives who can be assigned to it. */
export const BEDROOM_GROUPS = ["girls", "boys", "staff"] as const;
export type BedroomGroup = (typeof BEDROOM_GROUPS)[number];

/**
 * Bedrooms are NOT a category: each has its own bed layout (how many bunk
 * beds and how many single beds), which defines its capacity.
 */
export interface Bedroom {
  _id: string;
  /** import dry-run document; normal lists hide it until apply */
  draft?: boolean;
  importId?: string;
  /** door label, e.g. "103" */
  name: string;
  group: BedroomGroup;
  /** beliches — each sleeps 2 (top + bottom) */
  bunkBeds: number;
  /** camas de solteiro — each sleeps 1 */
  singleBeds: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

export function bedroomCapacity(b: Pick<Bedroom, "bunkBeds" | "singleBeds">): number {
  return b.bunkBeds * 2 + b.singleBeds;
}

// ── Participants (campers + team, camp operations only) ─────────────────

/**
 * Health category keys — the persons-api health lists (`GET /health-lists`,
 * church-wide, managed in Oikos). Health itself lives in persons-api
 * (kind `medical`); Acampa only references the option ids.
 */
export const STAFF_CATEGORY_KEYS = {
  allergies: "alergias",
  drugAllergies: "alergia-medicamentos",
  healthIssues: "condicao-cronica",
} as const;

/** One medicine (persons-api `medical.medications[]`) — kept here for the medication checklist. */
export interface Medication {
  name: string;
  dose: string;
  times: string[];
  asNeeded: boolean;
  notes: string;
}
export const MEDICATIONS_MAX = 20;
export const MEDICATION_TIMES_MAX = 12;

/** The health block of a person (persons-api kind `medical`, storage field `health`). Never stored in Acampa. */
export interface HealthInfo {
  allergies: string[];
  drugAllergies: string[];
  healthIssues: string[];
  neurodivergent: boolean;
  medications: Medication[];
  foodRestrictions: string;
  healthNotes: string;
  weightKg: number | null;
  insurance: string;
  insuranceCard: string;
}

export const EMPTY_HEALTH: HealthInfo = { allergies: [], drugAllergies: [], healthIssues: [], neurodivergent: false, medications: [], foodRestrictions: "", healthNotes: "", weightKg: null, insurance: "", insuranceCard: "" };

/** Shared by campers and team members: the participant row of one person in one camp (CONTRACTS §15). */
interface ParticipantBase {
  /** = personId (the IPAlpha person id) — every reference in camp ops uses it */
  _id: string;
  personId: string;
  /** id of a Team document (not a category) */
  team: string | null;
  /** id of a Transport document (bus / car) */
  transportation: string | null;
  /** id of a Bedroom document */
  bedroom: string | null;
  /** set when the person arrived on departure day */
  checkin: CamperCheckin | null;
  /** free camp-ops notes (Acampa keeps them — decision 33) */
  generalNotes: string;
  /** the persons-api import (§20) whose batch created / last filled this row; null for regular records */
  importId: string | null;
  /**
   * Import-fillable fields (keys only) a person changed by hand since an import last wrote them (decision 78):
   * a later import never overwrites them — it records an `importConflicts` entry the coordenação decides.
   */
  importEdited: string[];
  /** import dry-run row; hidden until apply */
  draft?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Staff extends ParticipantBase {
  kind: "team";
  /** inactive members are kept for history but hidden from the default lists */
  active: boolean;
  /**
   * What the person does in the room: a CARETAKER ("líder") is responsible
   * for specific kids (Camper.caretakerId), a HELPER ("auxiliar") only helps.
   */
  roomRole: RoomRole;
  /** the camp VEST (colete): handed out, then taken back */
  vest: VestStatus;
  /** Preparação items ticked as done: "section:<id>" / "role:<id>" */
  prepDone: string[];
  /** when the welcome message went out — null until then; sent ONCE */
  welcomeSentAt: Date | null;
  /** out-of-scope emergency QR lookups (distinct kids); ≥3 alerts the coordenação, ≥5 blocks */
  foreignLookupCount: number;
  /** person ids of the distinct out-of-scope kids already counted */
  foreignLookupCamperIds: string[];
  foreignLookupAlertedAt: Date | null;
}

// ── Teams (times) + scoreboard (placar) ──

/**
 * A camp TEAM ("Time Belém"): kids and staff are split into teams that
 * compete in the games. Managed by the admin (Settings → Times) — it used to
 * be the `equipe` category; the ids of the old options were kept as team ids
 * so `Staff.team` / `Camper.team` links survived (see models/teams.ts).
 */
export interface Team {
  _id: string;
  /** import dry-run document; normal lists hide it until apply */
  draft?: boolean;
  importId?: string;
  name: string;
  /** CSS colour (#rrggbb) shown on the scoreboard and tags */
  color: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One line of the scoreboard ledger: points given to (positive) or taken
 * from (negative) a team, by whom and why. A team's score is the SUM of its
 * lines; "zerar" writes a line that cancels the current total (`kind:
 * "reset"`), so the history is never lost.
 */
export interface ScoreEntry {
  _id: string;
  teamId: string;
  points: number;
  kind: "add" | "remove" | "reset";
  /** optional: why ("Gincana da piscina — 1º lugar") */
  note: string;
  /** set when the line came from scanning a kid's QR code: the kid's person id */
  camperId: string | null;
  /** the programme event the scan belongs to */
  eventId: string | null;
  /** who launched it (person id) */
  byPersonId: string;
  createdAt: Date;
}

// ── Campers (acampantes / crianças) ───────────────────────────────────

export const CAMPER_CATEGORY_KEYS = {
  bed: "cama",
  allergies: "alergias",
  drugAllergies: "alergia-medicamentos",
  healthIssues: "condicao-cronica",
} as const;

/** A kid's participant row: camp operations only (no name, birth date, documents, guardian or health — those live in core). */
export interface Camper extends ParticipantBase {
  kind: "camper";
  /** who invited the kid (free text — decision 33) */
  invitedBy: string;
  /** the team member (person id) who LOOKS AFTER this kid; null = no caretaker yet */
  caretakerId: string | null;
  /** token printed on the kid's QR badge */
  qrToken: string;
  /** bunk position (category option id) */
  bed: string | null;
  /** who the kid would like to share the room with (free text) */
  bedroomPreference: string;
  /** boarded the bus to the camp */
  busCheckin: CamperCheckin | null;
  /** boarded the bus back to the church */
  busReturnCheckin: CamperCheckin | null;
  /** when a PARENT last edited the kid's health (change log) — null until they do */
  parentEditedAt: Date | null;
}

export type CamperSex = "F" | "M";

export type RoomRole = "caretaker" | "helper";
export const ROOM_ROLES: readonly RoomRole[] = ["caretaker", "helper"];

/**
 * Check-out / check-in of the team vest (colete): `delivered` is stamped when
 * the person receives it, `returned` when they hand it back. Both null = not
 * delivered yet; `returned` is never set without `delivered`.
 */
export interface VestStatus {
  delivered: CamperCheckin | null;
  returned: CamperCheckin | null;
}

export interface CamperCheckin {
  at: Date;
  /** who did it (person id) */
  byPersonId: string;
  /** the acting core role */
  byRole: CoreRole;
  /** how it happened when nobody did it by hand */
  note?: string;
}

// ── Occurrences (incident / situation records) ──────────────────────────

/** Who wrote the occurrence — medical and organizers only see their own group; the coordenação sees all. */
export type OccurrenceGroup = "admin" | "organizer" | "medical";

/**
 * A record of something that happened during camp. Person references are
 * person ids — names are read live when displayed.
 */
export interface Occurrence {
  _id: string;
  /** kids involved (person ids) */
  campers: string[];
  /** team members involved (person ids) */
  staff: string[];
  /** sanitized HTML, including uploaded images */
  description: string;
  createdByPersonId: string;
  createdByRole: CoreRole;
  createdByGroup: OccurrenceGroup;
  createdAt: Date;
}

// ── Medication log (the medical team's checklist) ────────────────────────

/**
 * ONE dose actually given to a kid, ticked by the medical team on the
 * Medicações tab. The prescription itself lives on the camper
 * (`Camper.medications`); this is only the checklist of what was given, so
 * the team never has to remember whether the 12:30 pill already went out.
 *
 * `slot` is the prescribed "HH:MM" of that dose, or "sos" for a medicine
 * taken "quando necessário" (those may repeat in a day; a scheduled slot is
 * ticked once per day and unticking deletes the record).
 */
export interface MedicationDose {
  _id: string;
  /** the kid (person id) */
  personId: string;
  /** normalized medicine name — links the tick to the prescription */
  medKey: string;
  medName: string;
  dose: string;
  /** "YYYY-MM-DD" the dose belongs to */
  day: string;
  /** "HH:MM" of the prescribed moment, or "sos" */
  slot: string;
  givenAt: Date;
  byPersonId: string;
  /** optional remark */
  note: string;
}

/** "quando necessário" doses: no fixed time, may repeat in the same day */
export const MEDICATION_SOS_SLOT = "sos";

/**
 * Health fields a PARENT may edit on their own kid (written to persons-api
 * with the responsável token) + `generalNotes` (Acampa). Every one but
 * `generalNotes` counts as MEDICAL for the notifications.
 */
export const PARENT_EDITABLE_FIELDS = ["allergies", "drugAllergies", "healthIssues", "medications", "foodRestrictions", "healthNotes", "weightKg", "insurance", "insuranceCard", "generalNotes"] as const;
export type ParentEditableField = (typeof PARENT_EDITABLE_FIELDS)[number];
export type CamperChangeField = ParentEditableField | MedicalEditableField;

/** Health fields the medical team / coordenação may edit (written to persons-api with their role token). */
export const MEDICAL_EDITABLE_FIELDS = ["allergies", "drugAllergies", "healthIssues", "neurodivergent", "medications", "foodRestrictions", "healthNotes", "weightKg", "insurance", "insuranceCard"] as const;
export type MedicalEditableField = (typeof MEDICAL_EDITABLE_FIELDS)[number];

/** One edit to a kid's record — which FIELDS changed and who did it (values live in persons-api, never here). */
export interface CamperChangeLog {
  _id: string;
  personId: string;
  at: Date;
  byPersonId: string;
  byRole: CoreRole;
  /** true when at least one MEDICAL field changed (anything but `generalNotes`) */
  medical: boolean;
  fields: CamperChangeField[];
}

/** The kids' roll calls: church arrival, bus to camp, and bus back to church. */
export const CHECKIN_KINDS = ["church", "bus", "bus_return"] as const;
export type CheckinKind = (typeof CHECKIN_KINDS)[number];

/** Permanent audit trail of every check-in and undo (survives the undo itself). */
export interface CheckinLog {
  _id: string;
  /** "camper" (default) or "staff" */
  who?: "camper" | "staff";
  personId: string;
  kind: CheckinKind;
  action: "checkin" | "undo";
  at: Date;
  byPersonId: string;
  byRole: CoreRole;
  /** self check-in: the meeting point the person was at */
  note?: string;
}

// ── Schedule (programação): events + the roles staff fulfil in them ───────

/**
 * A role (função) a staff member can be assigned to during an event, e.g.
 * "Cuidar das crianças", "Base 3", "Coringa Belém". Defined ONCE and reused
 * across events; `instructions` is sanitized HTML written in the admin WYSIWYG
 * and shown to the staff member so they know what to do.
 */
export interface ScheduleRole {
  _id: string;
  name: string;
  emoji: string;
  /** sanitized HTML (may be empty) */
  instructions: string;
  /**
   * sanitized HTML (may be empty): what a person in this role must bring,
   * wear or prepare BEFORE the camp ("green army-style shirt + hat"). Shown
   * in the Preparação page, not in the programme.
   */
  preparation: string;
  /**
   * POSITIONS this role falls on by itself, with nobody being scaled one by
   * one: the link to a person is their `Staff.roomRole`. Both positions =
   * the whole team ("Cuidar das crianças"), one = only the LÍDERES or only
   * the AUXILIARES, `[]` = nobody automatically.
   *
   * This ADDS UP with the escala: a role may fall on the líderes AND carry a
   * few extra people picked by hand (`CampEvent.assignments`). Whoever is
   * explicitly scaled into another role of the event drops out of this one.
   */
  forRoomRoles: RoomRole[];
  /** whether an assignment of this role carries a per-person detail (team, base number, shift…) */
  hasDetail: boolean;
  /**
   * The detail is NOT typed per person: it IS the person's team
   * (`Staff.team`). Only meaningful together with `hasDetail`. When true only
   * staff members who have a team may be scaled into the role, and the chip
   * shown everywhere is the team (name + colour), read live from the staff
   * record — so moving somebody between teams updates every event at once.
   */
  detailFromTeam: boolean;
  /** placeholder / hint for that detail, e.g. "Time Belém", "Base 3", "14h–14h45" */
  detailPlaceholder: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A staff member scaled into a role of an event. `detail` holds the specifics
 *  the generic role doesn't (team name, base/colour number, shift).
 *  Both stay EMPTY when the role's `detailFromTeam` is on: the detail is then
 *  derived from `Staff.team` (see services/schedule.ts#assignmentDetail). */
export interface EventAssignment {
  /** the team member's person id */
  staffId: string;
  roleId: string;
  detail: string;
  /** "#rrggbb" tint for that detail chip (team colour), or "" for the default */
  detailColor: string;
}

/** A moment of the camp programme: "12/09 · 14:00 Piscina". */
export interface CampEvent {
  _id: string;
  /** calendar date "YYYY-MM-DD" */
  date: string;
  title: string;
  emoji: string;
  /** "HH:mm" */
  startTime: string;
  /** "HH:mm" or null when open-ended */
  endTime: string | null;
  notes: string;
  /** ids of the roles staff fulfil in this event */
  roles: string[];
  /** parents see this event on their programme (the team always does) */
  visibleToParents: boolean;
  assignments: EventAssignment[];
  createdAt: Date;
  updatedAt: Date;
}

// ── Preparation (preparação): what the team must know / bring before the camp ──

/**
 * A block of the Preparação page, written by the admin in the WYSIWYG
 * ("O que levar", "Chegada na igreja", "Uniforme"…). Shown to the whole
 * team, in `order`. Role-specific preparation lives on ScheduleRole.preparation.
 */
/** Who a general INSTRUCTIONS document is for: everyone, only the room CARETAKERS (responsáveis) or only the HELPERS (auxiliares). */
export type DocAudience = "all" | "caretaker" | "helper";
export const DOC_AUDIENCES: readonly DocAudience[] = ["all", "caretaker", "helper"];

/** One group a Preparação section is posted to: the PARENTS, the room CARETAKERS or the HELPERS — a section may target several at once. */
export type PrepAudience = "parent" | "caretaker" | "helper";
export const PREP_AUDIENCES: readonly PrepAudience[] = ["parent", "caretaker", "helper"];
/** what an old `audience: "all"` section (before parents existed) meant: the whole team */
export const PREP_TEAM_AUDIENCES: readonly PrepAudience[] = ["caretaker", "helper"];

export interface PrepSection {
  _id: string;
  title: string;
  emoji: string;
  /** who sees it (at least one) — parents only get sections listing `parent` */
  audiences: PrepAudience[];
  /** sanitized HTML (may include uploaded images) */
  content: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A general instructions DOCUMENT for the whole camp ("Regras do
 * acampamento", "Plano de emergência", "Rotina do dia"…), written by the
 * admin in the WYSIWYG editor and read by every team member.
 */
export interface InstructionDoc {
  _id: string;
  title: string;
  emoji: string;
  audience: DocAudience;
  /** sanitized HTML (may include uploaded images) — can be long */
  content: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/** An image uploaded through the WYSIWYG editor (kept in MongoDB, served by GET /api/files/:id). */
export interface StoredFile {
  /** random hex id — unguessable, so the GET route needs no auth (img tags can't send headers) */
  _id: string;
  name: string;
  /** MIME type, e.g. image/jpeg */
  type: string;
  size: number;
  byPersonId: string;
  createdAt: Date;
}

// ── Gallery (photos of the camp) ────────────────────────────────────────

/**
 * One photo of the camp, uploaded by a PHOTOGRAPHER (Settings → Fotógrafos).
 * May be tied to a programme event (`eventId`) or be general (null). The
 * full image lives in the `files` collection (same as the WYSIWYG uploads);
 * a small thumbnail is kept inside this document so the grid loads fast.
 *
 * Who may SEE the photos is not stored here: the whole album is published at
 * once through `settings.galleryPublished`.
 */
export interface GalleryPhoto {
  /** random hex id — unguessable, so GET /api/gallery/:id/thumb needs no auth */
  _id: string;
  /** id of the StoredFile with the full-size image */
  fileId: string;
  /** sort key, biggest first; seeded from the upload time, rewritten by drag & drop */
  order: number;
  caption: string;
  /** id of a CampEvent this photo belongs to; null = a general camp photo */
  eventId: string | null;
  byPersonId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Settings (admin-managed, one document for the whole camp) ─────────────

/**
 * One of the spots where the team may check themselves in on departure day
 * (the church, the camp site for whoever drives straight there…). The
 * self check-in accepts the NEAREST spot within its radius.
 */
export interface CheckinLocation {
  id: string;
  /** shown to the team: "Igreja", "Acampamento"… */
  name: string;
  lat: number;
  lng: number;
  /** how far from the point (in metres) still counts as "arrived" */
  radiusM: number;
}

/** Which changes are texted (SMS) to the team members concerned (see services/notify.ts). */
export interface NotificationSettings {
  /** a kid was put under (or taken from) the person's care — caretakers only (Camper.caretakerId changed) */
  bedroomChanges: boolean;
  /** the person is assigned, reassigned or removed from an event role, or that event moves / is deleted */
  roleChanges: boolean;
  /** the person's church check-in was recorded (by themselves or by the admin roll call) */
  checkinConfirmation: boolean;
  /** an Instruções document / Preparação section was created or edited, or the instructions / preparation text of one of the person's roles changed (TEAM) */
  contentChanges: boolean;
  /** a Preparação section posted to the PARENTS was created or edited → every parent with a phone, only while the parents' access window is open */
  parentContentChanges: boolean;
  /** the person's OWN allocation changed: bedroom, team or vehicle (bus) */
  staffChanges: boolean;
  /** the person was added to the team, or to an admin list (organizer, check-in / bus helper, medical, vest helper, parent contact) — always carries the app link */
  enrolments: boolean;
  /** an occurrence was registered (by the admin or the medical team) — every admin is texted */
  occurrences: boolean;
  /** at `settings.checkinReminder.at` the WHOLE team is reminded to do their check-in (nothing goes out while the date is unset) */
  checkinReminder: boolean;
  /** a parent edited their kid's "Informações de saúde": medical data → medical team + admins + caretaker; observations only → caretaker */
  parentEdits: boolean;
  /** the kid boarded the bus → the guardian is texted ("a caminho de um fim de semana incrível…") */
  busCheckin: boolean;
  /** when the PARENTS' access window opens each parent gets, ONCE ever, the "you're enrolled, here's the app" SMS */
  parentWelcome: boolean;
  /** a kid's birthday falls on a camp day → at 07:45 (São Paulo) that day the whole team of the kid's room is texted */
  birthdays: boolean;
  /** photos were PUBLISHED in the album → every team member (inside their window) and every parent (inside theirs) is texted */
  photoPublishes: boolean;
}

/** One-shot reminder to the whole team to do their check-in. */
export interface CheckinReminder {
  /** when to text everyone; null = no reminder */
  at: Date | null;
  /** when it actually went out (sent ONCE per `at`; reset whenever `at` changes) */
  sentAt: Date | null;
}

/** The time window in which the check-in helpers (church AND bus) may act. Both ends must be set for it to ever open. */
export interface CheckinWindow {
  from: Date | null;
  until: Date | null;
}

/**
 * One bus helper (core role `checkin-onibus`) at the door of one vehicle. The
 * role comes from projects-api; WHICH vehicle is camp ops, kept here.
 */
export interface BusHelper {
  personId: string;
  vehicleId: string;
}

export interface BusHelperList {
  helpers: BusHelper[];
}

/** A team member and the purpose shown beside them on the parents' contacts screen. */
export interface ParentContact {
  id: string;
  /** purpose shown to parents, e.g. "Coordenação do acampamento" */
  title: string;
  personId: string;
}

export interface Settings {
  /** at least one; the team's self check-in matches the nearest one */
  checkinLocations: CheckinLocation[];
  notifications: NotificationSettings;
  checkinWindow: CheckinWindow;
  /** return-trip bus roll call window; separate because it happens days after departure */
  busReturnWindow: CheckinWindow;
  /** which vehicle each `checkin-onibus` person stands at */
  busHelpers: BusHelperList;
  /** ordered contacts shared with parents */
  parentContacts: ParentContact[];
  /**
   * When ORDINARY team members (not organizers, check-in helpers, medical
   * team or parent contacts) may use the app. Both ends null = always. Outside
   * it the server sends them nothing (see services/scope.ts).
   */
  staffAccessWindow: CheckinWindow;
  /**
   * When PARENTS may log in and use the app. Both ends null = always. Also
   * the moment the parents' welcome SMS goes out (once per parent, see
   * notifications.parentWelcome). Independent from the parents' CONTACTS
   * window (check-in start → last event), which only decides what they see.
   */
  parentAccessWindow: CheckinWindow;
  /** test mode: church + bus check-in behave as if the window were open (the team's own self check-in is NOT affected) */
  checkinTestMode: boolean;
  /**
   * The kids' room allocation is still a DRAFT: while true, ordinary room
   * caretakers do not receive the kids of their room (admin, medical team and
   * check-in helpers are unaffected) and no "kid moved room" SMS goes out.
   */
  kidsRoomsDraft: boolean;
  /**
   * Scoreboard DRAFT (rehearsal) mode: the scoreboard normally only opens on
   * the camp days (first → last programme day). While true it opens for the
   * whole team and points may be launched regardless of the date — for the
   * organizers to test before the camp. Outside the camp days and with this
   * off, every score write is refused (SCORE_CLOSED).
   */
  scoreDraft: boolean;
  /**
   * Scoreboard SUSPENSE window (Settings → Jogos / the Placar page, set by the
   * game organizers): while `from <= now < until` the ledger is withheld from
   * everyone who does not launch points — the ordinary team sees the Placar
   * with the totals hidden. Points keep being written normally; at `until`
   * the board reappears for everybody. Both ends null = never hidden.
   */
  scoreHideWindow: CheckinWindow;
  /**
   * Setup wizard LOCK: after an admin login the assistant takes over until
   * they finish it or leave it. While on, the settings gear is blocked.
   */
  wizardMode: boolean;
  /**
   * The PHOTO ALBUM is visible to the camp. While false only the photographers
   * (and the admin / organizers) see the Fotos tab's pictures; flipping it on
   * publishes the whole album at once and texts everyone. Publishing is a
   * property of the album, never of a single photo.
   */
  galleryPublished: boolean;
  /** the "do your check-in" message to the whole team, scheduled for one instant */
  checkinReminder: CheckinReminder;
  updatedAt: Date | null;
}

/** An Acampa session (collection `sessions`). The browser holds only the opaque session token. */
export interface Session {
  /** sha256 (hex) of the opaque session token */
  _id: string;
  personId: string;
  /** every live project role at login (role switch picks from it) */
  roles: CoreRole[];
  activeRole: CoreRole;
  /** the camp this session is scoped to */
  campId: string;
  /** AES-256-GCM sealed `{role: {tokens, expiresAt, editionId}}` (SESSION_TOKEN_KEY) */
  roleTokens: string;
  /** AES-256-GCM sealed per-session key for the offline copy (rotated with every new session / role switch) */
  offlineKey: string;
  createdAt: Date;
  /** sliding: now + `hours` on use */
  expiresAt: Date;
  /** sessionIdleHours fixed at login */
  hours: number;
}

// ── Seeds (super-admin maintained templates the setup wizard imports) ──────

/** One room of a known camping place, as the wizard seeds it. */
export interface SeedPlaceRoom {
  name: string;
  group: "girls" | "boys" | "staff";
  bunkBeds: number;
  singleBeds: number;
}

/** A camping place the church already uses: rooms + beds, address, location. */
export interface SeedPlace {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  notes?: string;
  rooms: SeedPlaceRoom[];
}

/** A função template the schedule prefill creates when needed. */
export interface SeedRole {
  key: string;
  name: string;
  emoji: string;
  forRoomRoles: RoomRole[];
  hasDetail?: boolean;
  detailFromTeam?: boolean;
  detailPlaceholder?: string;
}

/** An event template; `day` is relative (1 = departure friday). */
export interface SeedEvent {
  day: number;
  start: string;
  end: string | null;
  title: string;
  emoji: string;
  roles: string[];
  visibleToParents?: boolean;
  notes?: string;
}

/** One bus of the fleet the wizard seeds on an empty camp. */
export interface SeedBus {
  number: string;
  color: string;
  capacity: number | null;
}

/** The two starter documents the wizard writes. */
export interface SeedDocs {
  prepTitle: string;
  prepEmoji: string;
  prepContent: string;
  addressTitle: string;
  addressEmoji: string;
}

/**
 * Everything the setup wizard imports, maintained by the SUPER ADMIN in
 * ⚙️ → Sementes. Stored as ONE document; `null` sections anywhere mean "use
 * the app's built-in defaults" (which is also what Restaurar returns to).
 */
export interface Seeds {
  places: SeedPlace[];
  roles: SeedRole[];
  events: SeedEvent[];
  fleet: SeedBus[];
  docs: SeedDocs;
  updatedAt: Date | null;
}
