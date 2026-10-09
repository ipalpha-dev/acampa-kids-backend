import { randomUUID } from "node:crypto";
import { listBedrooms, countStaffPerBedroom } from "../models/bedrooms";
import { EMPTY_CAMPER, countCampersPerBedroom, findCamperById, reassignCampers, insertCamper, updateCamper, type CamperData } from "../models/campers";
import { listCamps } from "../models/camps";
import { deleteImportConflict, upsertImportConflict } from "../models/importConflicts";
import {
  advanceImportJob,
  createImportJob,
  deleteImportJob,
  findImportJob,
  finishImportJob,
  FINAL_IMPORT_STATUSES,
  listUnfinishedImportJobs,
  setImportJobStatus,
  type ImportJob,
} from "../models/importJobs";
import { participantKind, type ImportField } from "../models/participants";
import { EMPTY_STAFF, findStaffById, insertStaff, updateStaff, type StaffData } from "../models/staff";
import { listTeams } from "../models/teams";
import { listTransports } from "../models/transports";
import { transportLabel } from "../routes/transports";
import { bedroomCapacity, COORDINATION_ROLE, PARTICIPANT_ROLE, RESPONSIBLE_ROLE, ROOM_ROLES, TEAM_ROLE, TEAM_ROLES, type RoomRole, type Session } from "../types";
import { withCamp } from "./campContext";
import { coreClient } from "./ipalpha";
import {
  IpalphaRejected,
  IpalphaTokenRevoked,
  IpalphaUnavailable,
  PERSONS_RESOURCE,
  toImportBatch,
  type ImportAppField,
  type ImportBatch,
  type ImportDecisions,
  type ImportTarget,
} from "./ipalpha/coreClient";
import { editionRolesOf } from "./members";
import { currentViewer, withViewerOf } from "./viewer";
import { emitImportEvent, publish } from "./realtime";

/**
 * Spreadsheet imports run in persons-api (CONTRACTS §20, decisions 58–63):
 * Acampa hands over the whole file with its own `appFields` (camp ops:
 * room, vehicle, team, room role, who invited, notes) and persons-api does
 * every step — column mapping, person matching, observation extraction
 * (health goes to core's health notes, never to Acampa), duplicates,
 * category mapping, registrations, links and memberships. Acampa receives
 * the results batch by batch (ids + app field values only — decision 67)
 * over the ONE dispatch app channel (services/dispatchChannel.ts) or the
 * signed webhook, and writes the app field values into `participants` by
 * personId.
 *
 * Decision 77: every import Acampa starts has an `importJobs` entry (ids
 * only) with the last batch applied here; at boot, on every app-channel
 * (re)connect and on the importer's reads, unfinished imports are caught up
 * from persons-api (`GET /imports/:id/batches`, cursor = the next batch
 * number) with the importer's own coordenação token. Batches are applied in
 * order, each once (`lastBatch` only moves forward). An import started
 * outside Acampa (Oikos, decision 63) with no live coordenação session
 * waits as an id only until one appears.
 *
 * Decision 78: a camp field a person changed by hand since the last import
 * (`participants.importEdited`) is never overwritten by a different import
 * value — an `importConflicts` entry asks the coordenação on the campers /
 * team page ("Aplicar valor da importação" / "Manter o atual").
 */

export type ImportSubject = "camper" | "team";
export const IMPORT_SUBJECTS: readonly ImportSubject[] = ["camper", "team"];
/** persons-api accepts ≤ 5 MB (§20) */
export const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_FILE_TYPES = /\.(csv|xlsx)$/i;

export const TEXT_LIMITS: Record<string, number> = { invitedBy: 120, bedroomPreference: 300, generalNotes: 1000 };
const ROOM_ROLE_LABELS: Record<RoomRole, string> = { caretaker: "Líder do quarto (responsável pelas crianças)", helper: "Auxiliar do quarto" };
const GROUP_LABELS: Record<string, string> = { girls: "meninas", boys: "meninos", staff: "equipe" };

/**
 * The person fields persons-api maps a column to (a copy of its `CORE_FIELDS`
 * keys — consumers copy what they need); `app:<key>` maps to an Acampa field.
 * Labels live in the browser (5 languages).
 */
export const IMPORT_CORE_FIELDS = [
  "name", "nickname", "birthDate", "sex", "homeChurch", "phone", "email", "cpf", "rg", "school", "schoolGrade", "emergencyContact",
  "insurance", "insuranceCard", "weightKg", "allergies", "drugAllergies", "healthIssues", "neurodivergent", "dailyMedication",
  "foodRestrictions", "healthNotes", "observations", "responsibleName", "responsiblePhone", "responsibleEmail", "responsibleCpf",
  "responsible2Name", "responsible2Phone", "rowKind",
] as const;
const APP_PREFIX = "app:";

/** §20 `targets`: a kid row registers the kid as participante and links its responsável(eis) (responsavel); a team row registers equipe. */
export function importTargets(subject: ImportSubject): Record<string, ImportTarget> {
  return subject === "camper" ? { camper: { role: PARTICIPANT_ROLE, responsibleRole: RESPONSIBLE_ROLE } } : { team: { role: TEAM_ROLE } };
}

/** The kind of participant row a job fills, read back from its `targets` (`{kind: {role, responsibleRole?}}`). */
export function subjectOfTargets(targets: unknown): ImportSubject | null {
  const roles = targets && typeof targets === "object" ? Object.values(targets as Record<string, unknown>).map((t) => (t && typeof t === "object" ? (t as { role?: unknown }).role : t)) : [];
  if (roles.includes(PARTICIPANT_ROLE)) return "camper";
  if (roles.includes(TEAM_ROLE)) return "team";
  return null;
}

/**
 * Acampa's app fields for persons-api (§20): the categories are the camp's
 * own rooms / vehicles / teams (keys = Acampa ids), so persons-api maps
 * "Ônibus azul", "quarto 3", "carona do João" to them with the same review
 * workflow as before. Descriptions are written for the AI mapping step.
 * REQUIRED (decision 62 — the importer must decide what to do with empty
 * rows before applying): the kid's way to the camp (every kid boards a
 * vehicle on departure day) and the team member's room role (it decides
 * what they see and which documents reach them).
 */
export async function appFieldsFor(subject: ImportSubject): Promise<ImportAppField[]> {
  const [rooms, vehicles, teams] = await Promise.all([listBedrooms(), listTransports(), listTeams()]);
  const roomCats = rooms
    .filter((r) => (subject === "camper" ? r.group !== "staff" : true))
    .map((r) => ({ key: r._id, label: `Quarto ${r.name} (${GROUP_LABELS[r.group] ?? r.group})` }));
  const vehicleCats = vehicles.map((t) => ({ key: t._id, label: t.kind === "bus" ? transportLabel(t) : `Carona: ${transportLabel(t)}` }));
  const teamCats = teams.map((t) => ({ key: t._id, label: t.name }));
  const transportation: ImportAppField = {
    key: "transportation",
    description:
      subject === "camper"
        ? "Como a criança vai ao acampamento: o ônibus da igreja (ex.: \"Ônibus 1 - Azul\") ou a carona / carro combinado (ex.: \"Carona: Carro do João\"). Use a coluna de transporte, ônibus ou carona da planilha."
        : "Como a pessoa da equipe vai ao acampamento: um dos ônibus ou a carona / carro combinado. Use a coluna de transporte, ônibus ou carona da planilha.",
    kind: "category",
    categories: vehicleCats,
    required: subject === "camper",
  };
  const bedroom: ImportAppField = {
    key: "bedroom",
    description:
      subject === "camper"
        ? "Quarto em que a criança vai dormir no acampamento (ex.: \"Quarto 3\"). Costuma ficar vazio na inscrição: a coordenação distribui os quartos depois."
        : "Quarto em que a pessoa da equipe vai dormir (ex.: \"Quarto 3\"), quando a planilha já trouxer.",
    kind: "category",
    categories: roomCats,
    required: false,
  };
  const team: ImportAppField = {
    key: "team",
    description: "Time / equipe de gincana do acampamento (ex.: \"Time Azul\"), quando a planilha já trouxer. Não é a função na equipe de serviço.",
    kind: "category",
    categories: teamCats,
    required: false,
  };
  const generalNotes: ImportAppField = {
    key: "generalNotes",
    description:
      "Observações gerais para quem cuida no acampamento que NÃO são de saúde (ex.: \"gosta de desenhar\", \"chega mais tarde no sábado\"). Nunca coloque aqui alergias, remédios, condições, restrições alimentares ou qualquer informação de saúde: isso vai para as anotações de saúde da pessoa no IPAlpha.",
    kind: "text",
    required: false,
  };
  // persons-api: a category field needs 1..200 options — one the camp has none of yet is not offered
  const usable = (f: ImportAppField) => f.kind !== "category" || ((f.categories?.length ?? 0) > 0 && (f.categories?.length ?? 0) <= 200);
  if (subject === "camper") {
    const camper: ImportAppField[] = [
      transportation,
      bedroom,
      team,
      { key: "bedroomPreference", description: "Com quem a criança gostaria de ficar no quarto (nomes de amigos), como a família escreveu. Nada de saúde.", kind: "text", required: false },
      { key: "invitedBy", description: "Quem convidou a criança para o acampamento (nome de quem convidou ou como conheceu), quando a planilha trouxer.", kind: "text", required: false },
      generalNotes,
    ];
    return camper.filter(usable);
  }
  const team_: ImportAppField[] = [
    {
      key: "roomRole",
      description: "Papel da pessoa no quarto: \"Líder do quarto\" (responsável pelas crianças do quarto) ou \"Auxiliar do quarto\". Na dúvida, auxiliar.",
      kind: "category",
      categories: ROOM_ROLES.map((r) => ({ key: r, label: ROOM_ROLE_LABELS[r] })),
      required: true,
    },
    transportation,
    bedroom,
    team,
    generalNotes,
  ];
  return team_.filter(usable);
}

// ── the job as the browser sees it ──────────────────────────────────────────

export interface ImportReviewView {
  id: string;
  kind: string;
  blocking: boolean;
  options: string[];
  rowRef: number | null;
  rowRefs: number[];
  /** a core field key, or `app:<key>` */
  field: string | null;
  who: string | null;
  basis: string | null;
  /** match: the existing person (id only) */
  existingPersonId: string | null;
  firstRowRef: number | null;
  choice: string | null;
  value: string | null;
  rows: Record<string, string> | null;
  resolved: boolean;
  /** the importer's own view only (never stored): the row's name from the file, the original cell, the raw category value, how many rows */
  context: { name?: string; original?: string; value?: string; rows?: number };
}

export interface ImportView {
  id: string;
  subject: ImportSubject | null;
  status: string;
  /**
   * persons-api's reason, passed through: `analysisFailed` (final), `membership:<reason>` (the importer may no longer
   * register — roleNotHeld, notSteward, editionMismatch, noGrant, outsideWindow — or the whole call was refused,
   * e.g. `membership:unknownEdition`), `projectsUnavailable` / `interrupted` / `internalError` (apply again resumes),
   * `projectsRefused` / `projectNotFound` (core configuration). Row reasons come with the batches.
   */
  failureReason: string | null;
  steps: { name: string; done: number; total: number }[];
  file: { name: string; size: number; sheet: string | null } | null;
  /** sheet column → core field key / `app:<key>` (null = ignored) */
  mapping: Record<string, string | null>;
  /** what a column may map to: core field keys + `app:<key>` of Acampa's fields */
  fields: string[];
  reviews: ImportReviewView[];
  appFields: ImportAppField[];
  counts: { rows: number; pending: number; batches: number; created: number; updated: number; skipped: number; failed: number };
  /** batches already written into `participants` here */
  applied: { batches: number };
  createdAt: string | null;
  expiresAt: string | null;
}

const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

function reviewView(x: unknown): ImportReviewView | null {
  const r = o(x);
  const id = s(r.id);
  if (!id) return null;
  const ctx = o(r.context);
  const rows = o(r.rows);
  return {
    id,
    kind: s(r.kind) ?? "review",
    blocking: r.blocking === true,
    options: (Array.isArray(r.options) ? r.options : []).filter((v): v is string => typeof v === "string"),
    rowRef: int(r.rowRef),
    rowRefs: (Array.isArray(r.rowRefs) ? r.rowRefs : []).filter((v): v is number => typeof v === "number"),
    field: s(r.field),
    who: s(r.who),
    basis: s(r.basis),
    existingPersonId: s(r.existingPersonId),
    firstRowRef: int(r.firstRowRef),
    choice: s(r.choice),
    value: typeof r.value === "string" ? r.value : null,
    rows: r.rows && typeof r.rows === "object" ? Object.fromEntries(Object.entries(rows).filter(([, v]) => typeof v === "string")) as Record<string, string> : null,
    resolved: r.resolved === true,
    context: {
      ...(typeof ctx.name === "string" ? { name: ctx.name } : {}),
      ...(typeof ctx.original === "string" ? { original: ctx.original } : {}),
      ...(typeof ctx.value === "string" ? { value: ctx.value } : {}),
      ...(typeof ctx.rows === "number" ? { rows: ctx.rows } : {}),
    },
  };
}

/**
 * persons `GET /imports/:id` → a stable view for the import screen. Core's
 * job never carries rows (§20); anything unknown is dropped. Review context
 * (the row's name from the file) is passed to the importer's screen only —
 * never stored or logged here.
 */
export function importView(job: Record<string, unknown>, ours: ImportAppField[], applied: { batches: number } = { batches: 0 }): ImportView {
  const counts = o(job.counts);
  const file = o(job.file);
  return {
    id: s(job.id) ?? s(job.importId) ?? "",
    subject: subjectOfTargets(job.targets),
    status: s(job.status) ?? "analysing",
    failureReason: s(job.failureReason),
    steps: (Array.isArray(job.steps) ? job.steps : []).map((x) => ({ name: s(o(x).name) ?? "", done: n(o(x).done), total: n(o(x).total) })).filter((x) => x.name),
    file: s(file.name) ? { name: s(file.name)!, size: n(file.size), sheet: s(file.sheet) } : null,
    mapping: Object.fromEntries(Object.entries(o(job.mapping)).map(([col, field]) => [col, typeof field === "string" ? field : null])),
    fields: [...IMPORT_CORE_FIELDS, ...ours.map((f) => `${APP_PREFIX}${f.key}`)],
    reviews: (Array.isArray(job.reviews) ? job.reviews : []).map(reviewView).filter((r): r is ImportReviewView => r !== null),
    appFields: ours,
    counts: { rows: n(counts.rows), pending: n(counts.pending), batches: n(counts.batches), created: n(counts.created), updated: n(counts.updated), skipped: n(counts.skipped), failed: n(counts.failed) },
    applied,
    createdAt: s(job.createdAt),
    expiresAt: s(job.expiresAt),
  };
}

// ── decisions (PATCH) ───────────────────────────────────────────────────────

const MAX_DECISIONS = 5000;

/**
 * The browser's decisions in persons-api's own shape (`{mapping?, reviews?:
 * [{id, choice?, value?, rows?}]}`), checked against Acampa's app fields
 * (category keys, text limits) before they go to persons-api, which checks
 * the rest (review ids, options, values).
 */
export function parseDecisions(body: unknown, fields: ImportAppField[]): { ok: true; decisions: ImportDecisions } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Decisões inválidas." };
  const b = body as Record<string, unknown>;
  const out: ImportDecisions = {};
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const known = new Set<string>([...IMPORT_CORE_FIELDS, ...fields.map((f) => `${APP_PREFIX}${f.key}`)]);
  const fits = (f: ImportAppField, v: string) => (f.kind === "category" ? (f.categories ?? []).some((c) => c.key === v) : v.trim().length > 0 && v.length <= (TEXT_LIMITS[f.key] ?? 300));
  if (b.mapping !== undefined) {
    const m = o(b.mapping);
    if (b.mapping === null || typeof b.mapping !== "object" || Array.isArray(b.mapping)) return { ok: false, message: "Mapeamento de colunas inválido." };
    for (const [col, field] of Object.entries(m)) {
      if (col.length > 200 || (field !== null && (typeof field !== "string" || !known.has(field)))) return { ok: false, message: "Mapeamento de colunas inválido." };
    }
    out.mapping = m as Record<string, string | null>;
  }
  if (b.reviews !== undefined) {
    if (!Array.isArray(b.reviews) || b.reviews.length > MAX_DECISIONS) return { ok: false, message: "Escolhas de revisão inválidas." };
    const list: NonNullable<ImportDecisions["reviews"]> = [];
    for (const raw of b.reviews) {
      const d = o(raw);
      const id = typeof d.id === "string" ? d.id : "";
      if (!id || id.length > 120) return { ok: false, message: "Escolha de revisão inválida." };
      if (d.choice !== undefined && (typeof d.choice !== "string" || d.choice.length > 200)) return { ok: false, message: "Escolha de revisão inválida." };
      if (d.value !== undefined && (typeof d.value !== "string" || d.value.length > 2000)) return { ok: false, message: "Valor de revisão inválido." };
      if (d.rows !== undefined && (typeof d.rows !== "object" || d.rows === null || Array.isArray(d.rows) || Object.values(d.rows).some((v) => typeof v !== "string"))) {
        return { ok: false, message: "Valores por linha inválidos." };
      }
      const choice = d.choice as string | undefined;
      const value = d.value as string | undefined;
      const rows = d.rows as Record<string, string> | undefined;
      // Acampa's own fields: the value must be one of the camp's options / fit the text limits
      const category = /^category:([^:]+):\d+$/.exec(id);
      if (category) {
        const f = byKey.get(category[1]);
        if (!f || f.kind !== "category" || (choice !== undefined && choice !== "none" && !fits(f, choice))) return { ok: false, message: `Opção inválida em "${category[1]}".` };
      }
      const required = /^required:(.+)$/.exec(id);
      if (required) {
        const f = byKey.get(required[1]);
        if (!f?.required) return { ok: false, message: `Campo "${required[1]}" não é obrigatório.` };
        if (choice === "default" && (value === undefined || !fits(f, value))) return { ok: false, message: `Decisão inválida para "${required[1]}".` };
        if (rows && Object.values(rows).some((v) => v !== "skip" && !fits(f, v))) return { ok: false, message: `Decisão inválida para "${required[1]}".` };
      }
      list.push({ id, ...(choice !== undefined ? { choice } : {}), ...(value !== undefined ? { value: value.trim() } : {}), ...(rows ? { rows } : {}) });
    }
    out.reviews = list;
  }
  if (out.mapping === undefined && out.reviews === undefined) return { ok: false, message: "Nenhuma decisão enviada." };
  return { ok: true, decisions: out };
}

// ── applying batches to participants ────────────────────────────────────────

export interface BatchOutcome {
  rows: number;
  applied: number;
  skipped: number;
  unfilled: number;
  /** import values kept aside because a person changed that field by hand (decision 78) */
  conflicts: number;
}

const same = (a: unknown, b: unknown) => (a ?? "") === (b ?? "");

/**
 * One batch → `participants` (camp ops) of `campId`. A row already stamped
 * with this import is left alone (socket + webhook + catch-up may all bring
 * it). Per field: a value the person changed by hand since the last import
 * (`importEdited`) is never overwritten by a different import value — an
 * `importConflicts` entry asks the coordenação instead (decision 78).
 */
export async function applyBatch(importId: string, batch: ImportBatch, ctx: { campId: string; subject: ImportSubject | null }): Promise<BatchOutcome> {
  return withCamp(ctx.campId, async () => {
    const out: BatchOutcome = { rows: batch.rows.length, applied: 0, skipped: 0, unfilled: 0, conflicts: 0 };
    const [rooms, vehicles, teams, campersPerRoom, staffPerRoom] = await Promise.all([listBedrooms(), listTransports(), listTeams(), countCampersPerBedroom(), countStaffPerBedroom()]);
    const roomById = new Map(rooms.map((r) => [r._id, r]));
    const vehicleIds = new Set(vehicles.map((v) => v._id));
    const teamIds = new Set(teams.map((t) => t._id));
    const occupied = (id: string) => (campersPerRoom.get(id) ?? 0) + (staffPerRoom.get(id) ?? 0);
    const touched = new Set<ImportSubject>();
    for (const row of batch.rows) {
      out.unfilled += row.unfilled.length;
      if (!row.personId || (row.status !== "created" && row.status !== "updated")) {
        out.skipped++;
        continue;
      }
      const subject = ctx.subject ?? (await subjectOfPerson(row.personId, ctx.campId));
      const existingKind = await participantKind(row.personId);
      if (!subject || (existingKind && existingKind !== (subject === "camper" ? "camper" : "team"))) {
        out.skipped++;
        continue;
      }
      const current = subject === "camper" ? await findCamperById(row.personId) : await findStaffById(row.personId);
      if (current?.importId === importId) continue; // already applied (socket + webhook + catch-up)
      const v = row.appFields;
      const values: Partial<Record<ImportField, string>> = {};
      const text = (key: ImportField) => {
        const t = (v[key] ?? "").trim();
        if (t) values[key] = t.slice(0, TEXT_LIMITS[key] ?? 300);
      };
      const pick = (key: ImportField, ok: (id: string) => boolean) => {
        const id = (v[key] ?? "").trim();
        if (!id) return;
        if (ok(id)) values[key] = id;
        else out.unfilled++;
      };
      pick("transportation", (id) => vehicleIds.has(id));
      pick("team", (id) => teamIds.has(id));
      pick("bedroom", (id) => {
        const room = roomById.get(id);
        return !!room && !(subject === "camper" && room.group === "staff");
      });
      text("generalNotes");
      if (subject === "camper") {
        text("invitedBy");
        text("bedroomPreference");
      } else {
        pick("roomRole", (id) => (ROOM_ROLES as readonly string[]).includes(id));
      }
      const edited = new Set(current?.importEdited ?? []);
      const patch: Record<string, unknown> = { importId };
      for (const [key, value] of Object.entries(values) as [ImportField, string][]) {
        const now = current ? ((current as unknown as Record<string, unknown>)[key] as string | null | undefined) ?? null : null;
        if (current && !same(now, value) && edited.has(key)) {
          // decision 78: the person's own choice stays; the coordenação decides on the campers / team page
          await upsertImportConflict({ personId: row.personId, kind: subject === "camper" ? "camper" : "team", field: key, importId, importValue: value, currentValue: now === "" ? null : now });
          out.conflicts++;
          continue;
        }
        if (key === "bedroom" && !same(now, value)) {
          const room = roomById.get(value)!;
          // a full room is never overfilled by an import: the row keeps no room (counted as unfilled)
          if (occupied(value) >= bedroomCapacity(room)) {
            out.unfilled++;
            continue;
          }
          if (subject === "camper") campersPerRoom.set(value, (campersPerRoom.get(value) ?? 0) + 1);
          else staffPerRoom.set(value, (staffPerRoom.get(value) ?? 0) + 1);
        }
        patch[key] = value;
        if (current) await deleteImportConflict(row.personId, key);
      }
      if (subject === "camper") {
        if (current && patch.bedroom !== undefined && patch.bedroom !== current.bedroom) {
          Object.assign(patch, { bed: null, caretakerId: null });
          if (current.bedroom) campersPerRoom.set(current.bedroom, Math.max(0, (campersPerRoom.get(current.bedroom) ?? 0) - 1));
        }
        if (current) await updateCamper(row.personId, patch as Partial<CamperData>, "import");
        else await insertCamper(row.personId, { ...EMPTY_CAMPER, qrToken: randomUUID(), ...(patch as Partial<CamperData>) }, "import");
      } else {
        if (current) {
          const staff = current as import("../types").Staff;
          const bedroom = patch.bedroom === undefined ? staff.bedroom : patch.bedroom;
          const roomRole = patch.roomRole === undefined ? staff.roomRole : patch.roomRole;
          if (staff.roomRole === "caretaker" && (bedroom !== staff.bedroom || roomRole !== "caretaker")) {
            await reassignCampers(row.personId, null);
            touched.add("camper");
          }
          if (bedroom !== staff.bedroom && staff.bedroom) staffPerRoom.set(staff.bedroom, Math.max(0, (staffPerRoom.get(staff.bedroom) ?? 0) - 1));
        }
        if (current) await updateStaff(row.personId, patch as Partial<StaffData>, "import");
        else await insertStaff(row.personId, { ...EMPTY_STAFF, ...(patch as Partial<StaffData>) }, "import");
      }
      out.applied++;
      touched.add(subject);
    }
    if (touched.size > 0) publish(...(touched.has("camper") ? (["campers"] as const) : []), ...(touched.has("team") ? (["staff"] as const) : []), "bedrooms");
    return out;
  });
}

/** An import nobody here started (Oikos): the person's live edition role says kid or team. */
async function subjectOfPerson(personId: string, campId: string): Promise<ImportSubject | null> {
  const roles = await editionRolesOf(personId, [PARTICIPANT_ROLE, ...TEAM_ROLES], campId);
  if (roles.includes(PARTICIPANT_ROLE)) return "camper";
  if (roles.some((r) => r !== RESPONSIBLE_ROLE)) return "team";
  return null;
}

/** Resolve the import edition without falling back to another camp's roster (a camp without a stored edition is looked up with `session`'s token). */
export async function campOfEdition(editionId: string | null, session: Session | null = currentViewer()): Promise<string> {
  if (!editionId) throw new IpalphaRejected(409, "unknownEdition", {});
  const { campEditionId } = await import("./acting");
  for (const camp of await listCamps()) {
    if ((camp.editionId ?? await campEditionId(camp._id, session)) === editionId) return camp._id;
  }
  throw new IpalphaRejected(409, "unknownEdition", {});
}

// ── which list an import fills (memory only, this process) ───────────────────

/** importId → camper / team, learnt from the job's targets (persons-api) — never stored. */
const subjects = new Map<string, ImportSubject>();
const SUBJECTS_MAX = 500;

export function rememberSubject(importId: string, subject: ImportSubject | null): void {
  if (!subject) return;
  if (subjects.size >= SUBJECTS_MAX && !subjects.has(importId)) subjects.delete(subjects.keys().next().value!);
  subjects.set(importId, subject);
}

export function subjectOf(importId: string): ImportSubject | null {
  return subjects.get(importId) ?? null;
}

/**
 * Import ids that arrived (Oikos, decision 63) before any coordenação
 * session could read them. Ids only (decision 70). Lost on restart: persons-api
 * keeps results for 30 days, and GET /api/imports/:id still adopts the import.
 */
const pendingImports = new Set<string>();
const PENDING_IMPORTS_MAX = 500;

function rememberPendingImport(importId: string): void {
  if (pendingImports.has(importId)) return;
  if (pendingImports.size >= PENDING_IMPORTS_MAX) pendingImports.delete(pendingImports.keys().next().value!);
  pendingImports.add(importId);
}

/** tests only */
export function clearImportMemory(): void {
  subjects.clear();
  pendingImports.clear();
}

// ── importJobs: tracking + catch-up (decision 77) ───────────────────────────

/** Records an import Acampa started (ids only). */
export async function trackImport(input: { importId: string; campId: string; startedBy: string; status: string; subject: ImportSubject }): Promise<ImportJob> {
  rememberSubject(input.importId, input.subject);
  return createImportJob({ importId: input.importId, campId: input.campId, startedBy: input.startedBy, status: FINAL_IMPORT_STATUSES.has(input.status) ? "applying" : input.status });
}

/** A live coordenação session of the importer with its persons token (null = none: caught up on their next visit). */
async function importerSession(personId: string): Promise<{ session: Session; token: string } | null> {
  const { listLiveSessionsOf } = await import("./session");
  const { coordinationToken } = await import("./acting");
  for (const session of await listLiveSessionsOf(personId)) {
    if (!session.roles.includes(COORDINATION_ROLE)) continue;
    try {
      const token = coordinationToken(session, PERSONS_RESOURCE);
      if (token) return { session, token };
    } catch {
      // that session's coordenação token expired — try the next one
    }
  }
  return null;
}

async function importerToken(personId: string): Promise<string | null> {
  return (await importerSession(personId))?.token ?? null;
}

/**
 * Applies one batch for a tracked import and moves its `lastBatch` (only from `from`). Member reads act for the
 * request's session, else for one of the importer's live coordenação sessions (a socket / webhook has no viewer).
 */
async function applyTracked(job: ImportJob, batch: ImportBatch, subject: ImportSubject | null): Promise<BatchOutcome | null> {
  const viewer = currentViewer() ?? (await importerSession(job.startedBy))?.session ?? null;
  const outcome = await withViewerOf(viewer, () => applyBatch(job.importId, batch, { campId: job.campId, subject }));
  if (!(await advanceImportJob(job.importId, job.lastBatch, batch.batch))) return null; // another pass already moved it
  job.lastBatch = batch.batch;
  emitImportEvent(job.startedBy, job.campId, "import-batch", { importId: job.importId, batch: batch.batch, ...outcome });
  console.log(`[imports] ${job.importId} batch ${batch.batch}: ${outcome.applied}/${outcome.rows} applied, ${outcome.conflicts} to review`);
  return outcome;
}

export type CatchUp = "caughtUp" | "noToken" | "gone" | "unavailable";

/**
 * Reads every batch after `lastBatch` from persons-api (the owner keeps them
 * until the import expires — decision 64) and applies them in order; marks
 * the entry final once persons-api says the import ended and the last batch
 * was read. `token`: the importer's (a request's own), else one of their
 * live sessions'. Must run inside the import queue.
 */
export async function catchUpImport(importId: string, token?: string | null, reconcileFinal = false): Promise<CatchUp> {
  const job = await findImportJob(importId);
  if (!job || !reconcileFinal && FINAL_IMPORT_STATUSES.has(job.status)) return "caughtUp";
  const bearer = token ?? (await importerToken(job.startedBy));
  if (!bearer) return "noToken";
  const client = coreClient();
  try {
    const view = await client.getImport(bearer, importId);
    const status = s(view.status) ?? job.status;
    const subject = subjectOf(importId) ?? subjectOfTargets(view.targets);
    rememberSubject(importId, subject);
    let cursor = job.lastBatch + 1;
    let exhausted = false;
    for (let guard = 0; guard < 1000; guard++) {
      const page = await client.importBatches(bearer, importId, { cursor, limit: 10 });
      for (const b of [...page.items].sort((x, y) => x.batch - y.batch)) {
        if (b.batch <= job.lastBatch) continue;
        if (b.batch !== job.lastBatch + 1) return "unavailable";
        await applyTracked(job, b, subject);
      }
      const next = page.nextCursor ? Number(page.nextCursor) : NaN;
      if (!Number.isInteger(next) || next <= job.lastBatch) {
        exhausted = true;
        break;
      }
      cursor = next;
    }
    if (!exhausted) return "unavailable";
    if (FINAL_IMPORT_STATUSES.has(status)) await finishImportJob(importId, status);
    else await setImportJobStatus(importId, status);
    return "caughtUp";
  } catch (err) {
    if (err instanceof IpalphaRejected && err.status === 404) {
      // persons-api dropped it (expired / cancelled long ago): nothing left to read
      await deleteImportJob(importId);
      return "gone";
    }
    if (err instanceof IpalphaTokenRevoked || err instanceof IpalphaUnavailable || err instanceof IpalphaRejected) return "unavailable";
    throw err;
  }
}

/**
 * Reads one untracked import with a live coordenação token, records the
 * `importJobs` entry (ids only) and applies every retained batch. Must run
 * inside the import queue. True when the import is tracked (or already was).
 */
async function adoptImport(importId: string, projectId: string): Promise<boolean> {
  if (await findImportJob(importId)) return true;
  const { getDb } = await import("../db");
  const owners = await (await getDb()).collection("sessions").distinct("personId", { roles: COORDINATION_ROLE, expiresAt: { $gt: new Date() } });
  for (const personId of owners) {
    const importer = await importerSession(String(personId));
    if (!importer) continue;
    const { session, token } = importer;
    try {
      const view = await coreClient().getImport(token, importId);
      const subject = subjectOfTargets(view.targets);
      if (!subject || (view.projectId && view.projectId !== projectId)) return true;
      const campId = await campOfEdition(s(view.editionId), session);
      await trackImport({ importId, campId, startedBy: s(view.createdBy) ?? String(personId), status: s(view.status) ?? "applying", subject });
      await catchUpImport(importId, token);
      return true;
    } catch (err) {
      if (err instanceof IpalphaRejected && (err.status === 403 || err.status === 404)) continue;
      throw err;
    }
  }
  return false;
}

/**
 * A coordenação session just became live (login, role switch) or the app
 * channel (re)subscribed: adopt imports that arrived with nobody here able
 * to read them. Idempotent; a failure leaves the id for the next try.
 */
export function adoptPendingImports(projectId: string): void {
  if (pendingImports.size === 0) return;
  const ids = [...pendingImports];
  void (async () => {
    for (const importId of ids) {
      const adopted = await runInImportQueue(() => adoptImport(importId, projectId)).catch(() => false);
      if (adopted) pendingImports.delete(importId);
    }
  })();
}

/** Boot / app-channel (re)connect: catch up every unfinished import (in the queue, one by one). Returns how many were read. */
export async function catchUpUnfinished(): Promise<number> {
  let done = 0;
  for (const job of await listUnfinishedImportJobs()) {
    const result = await runInImportQueue(() => catchUpImport(job.importId)).catch(() => "unavailable" as const);
    if (result === "caughtUp") done++;
  }
  return done;
}

// ── app-channel / webhook messages (§21) ────────────────────────────────────

export interface AppMessage {
  id: string;
  type: "person-import.progress" | "person-import.batch";
  importId: string;
  projectId: string;
  step: string;
  done: number;
  total: number;
  status: string;
  batch?: number;
  rows?: unknown[];
}

/** A §21 message body (socket event or webhook), or null when it is not one. */
export function toAppMessage(v: unknown): AppMessage | null {
  const m = o(v);
  const id = s(m.id);
  const importId = s(m.importId);
  if (!id || !importId || (m.type !== "person-import.progress" && m.type !== "person-import.batch")) return null;
  return {
    id,
    type: m.type,
    importId,
    projectId: s(m.projectId) ?? "",
    step: s(m.step) ?? "",
    done: n(m.done),
    total: n(m.total),
    status: s(m.status) ?? "",
    ...(typeof m.batch === "number" && Number.isInteger(m.batch) && m.batch >= 1 ? { batch: m.batch } : {}),
    ...(Array.isArray(m.rows) ? { rows: m.rows } : {}),
  };
}

/**
 * One message from dispatch (socket or webhook — the caller already
 * authenticated it). Progress → the importer's sockets; the next batch →
 * applied to `participants`; a batch out of order, a batch without rows
 * (too big for dispatch) or the end of the import → caught up from
 * persons-api with the importer's token. Only for Acampa's own project.
 */
export async function handleAppMessage(msg: AppMessage, projectId: string): Promise<void> {
  if (msg.projectId && msg.projectId !== projectId) return;
  let job = await findImportJob(msg.importId);
  if (!job) {
    if (await adoptImport(msg.importId, projectId)) {
      pendingImports.delete(msg.importId);
      return;
    }
    // No authorized importer session, and campId / startedBy cannot be known without a token.
    // The id waits (in-process) until a coordenação session is live. Lost on restart:
    // persons-api keeps the results 30 days, and GET /api/imports/:id still adopts it.
    rememberPendingImport(msg.importId);
    return;
  }
  emitImportEvent(job.startedBy, job.campId, "import-progress", { importId: msg.importId, step: msg.step, done: msg.done, total: msg.total, status: msg.status, ...(msg.batch !== undefined ? { batch: msg.batch } : {}) });
  if (FINAL_IMPORT_STATUSES.has(job.status)) return;
  if (msg.status && msg.status !== job.status) await setImportJobStatus(job.importId, msg.status);
  if (msg.type === "person-import.batch" && msg.batch !== undefined) {
    if (msg.batch <= job.lastBatch) return;
    const batch = msg.rows ? toImportBatch({ batch: msg.batch, rows: msg.rows }) : null;
    if (batch && msg.batch === job.lastBatch + 1) {
      await applyTracked(job, batch, subjectOf(job.importId));
      if (!FINAL_IMPORT_STATUSES.has(msg.status)) return;
    }
  } else if (!FINAL_IMPORT_STATUSES.has(msg.status)) {
    return;
  }
  // a gap, a batch without rows, or the end: read the rest from persons-api
  await catchUpImport(job.importId);
}

// ── one queue for every import write (socket, webhook, catch-up, reads): batches never race each other ──

let queue: Promise<unknown> = Promise.resolve();
let queued = 0;
const QUEUE_MAX = 500;

/** Runs `task` after every queued one; rejects with the task's own error. */
export function runInImportQueue<T>(task: () => Promise<T>): Promise<T> {
  queued++;
  const run = queue.then(task);
  queue = run.catch(() => undefined).finally(() => {
    queued--;
  });
  return run;
}

/** Runs `handleAppMessage` in arrival order; never rejects (a failure is logged — the catch-up reads it again). */
export function enqueueAppMessage(msg: AppMessage, projectId: string): Promise<void> {
  if (queued >= QUEUE_MAX) {
    console.warn("[imports] message queue full — dropped (the catch-up reads it from persons-api)");
    return Promise.resolve();
  }
  return runInImportQueue(() => handleAppMessage(msg, projectId)).catch((err) => {
    console.warn(`[imports] ${msg.importId} message failed (${err instanceof Error ? err.message : "error"}) — the catch-up reads it again`);
  });
}
