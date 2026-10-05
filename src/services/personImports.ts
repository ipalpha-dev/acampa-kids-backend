import { randomUUID } from "node:crypto";
import { listBedrooms, countStaffPerBedroom } from "../models/bedrooms";
import { EMPTY_CAMPER, countCampersPerBedroom, findCamperById, insertCamper, updateCamper, type CamperData } from "../models/campers";
import { listCamps } from "../models/camps";
import { participantKind } from "../models/participants";
import { EMPTY_STAFF, findStaffById, insertStaff, updateStaff, type StaffData } from "../models/staff";
import { listTeams } from "../models/teams";
import { listTransports } from "../models/transports";
import { transportLabel } from "../routes/transports";
import { bedroomCapacity, PARTICIPANT_ROLE, RESPONSIBLE_ROLE, ROOM_ROLES, TEAM_ROLE, type RoomRole } from "../types";
import { activeCampId, withCamp } from "./campContext";
import { coreClient } from "./ipalpha";
import { IpalphaRejected, IpalphaTokenRevoked, IpalphaUnavailable, PERSONS_RESOURCE, toImportBatch, type ImportAppField, type ImportBatch } from "./ipalpha/coreClient";
import { editionRolesOf } from "./members";
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
 * Nothing about an import is stored here except, in memory, which person
 * started which import id (to push progress to their sockets and reconcile
 * with their token). Applying is idempotent through the row's `importId`
 * (a row already stamped with this import is not touched again), so a batch
 * read twice — socket + webhook + reconciliation — changes nothing.
 */

export type ImportSubject = "camper" | "team";
export const IMPORT_SUBJECTS: readonly ImportSubject[] = ["camper", "team"];
/** persons-api accepts ≤ 5 MB (§20) */
export const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_FILE_TYPES = /\.(csv|xlsx|xls)$/i;

const TEXT_LIMITS: Record<string, number> = { invitedBy: 120, bedroomPreference: 300, generalNotes: 1000 };
const ROOM_ROLE_LABELS: Record<RoomRole, string> = { caretaker: "Líder do quarto (responsável pelas crianças)", helper: "Auxiliar do quarto" };
const GROUP_LABELS: Record<string, string> = { girls: "meninas", boys: "meninos", staff: "equipe" };

/** §20 `targets` (rowKind → project role): a kid row registers the kid as participante and its responsável(eis) as responsavel. */
export function importTargets(subject: ImportSubject): Record<string, string> {
  return subject === "camper" ? { camper: PARTICIPANT_ROLE, responsible: RESPONSIBLE_ROLE } : { team: TEAM_ROLE };
}

/** The kind of participant row a job fills, read back from its `targets`. */
export function subjectOfTargets(targets: unknown): ImportSubject | null {
  const roles = targets && typeof targets === "object" ? Object.values(targets as Record<string, unknown>).flat() : [];
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
  if (subject === "camper") {
    return [
      transportation,
      bedroom,
      team,
      { key: "bedroomPreference", description: "Com quem a criança gostaria de ficar no quarto (nomes de amigos), como a família escreveu. Nada de saúde.", kind: "text", required: false },
      { key: "invitedBy", description: "Quem convidou a criança para o acampamento (nome de quem convidou ou como conheceu), quando a planilha trouxer.", kind: "text", required: false },
      generalNotes,
    ];
  }
  return [
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
}

// ── in-memory tracking (ids only, this process) ─────────────────────────────

interface Tracked {
  importId: string;
  campId: string;
  subject: ImportSubject;
  /** who started it in Acampa (their sockets hear the progress) */
  personId: string;
  /** their Acampa session (its coordenação token reads missed batches) */
  sessionId: string;
  applied: Set<number>;
  appliedRows: number;
  lastReconciledAt: number;
  finishedAt: number | null;
}

const TRACK_MAX = 200;
const TRACK_TTL_MS = 30 * 24 * 3600_000;
const tracked = new Map<string, Tracked>();

export function trackImport(input: { importId: string; campId: string; subject: ImportSubject; personId: string; sessionId: string }): void {
  if (tracked.size >= TRACK_MAX) {
    const oldest = [...tracked.values()].sort((a, b) => (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity))[0];
    if (oldest) tracked.delete(oldest.importId);
  }
  const prev = tracked.get(input.importId);
  tracked.set(input.importId, { ...input, applied: prev?.applied ?? new Set(), appliedRows: prev?.appliedRows ?? 0, lastReconciledAt: prev?.lastReconciledAt ?? 0, finishedAt: prev?.finishedAt ?? null });
}

export function trackedImport(importId: string): Readonly<Tracked> | null {
  const t = tracked.get(importId) ?? null;
  if (t?.finishedAt && Date.now() - t.finishedAt > TRACK_TTL_MS) {
    tracked.delete(importId);
    return null;
  }
  return t;
}

export function untrackImport(importId: string): void {
  tracked.delete(importId);
}

/** Every tracked import that may still have batches to read (reconnect reconciliation). */
export function openImports(): Tracked[] {
  return [...tracked.values()].filter((t) => !t.finishedAt || t.lastReconciledAt < t.finishedAt);
}

/** tests only */
export function clearTrackedImports(): void {
  tracked.clear();
}

export const FINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

// ── the job as the browser sees it ──────────────────────────────────────────

export interface ImportView {
  id: string;
  subject: ImportSubject | null;
  status: string;
  steps: { name: string; done: number; total: number }[];
  file: { name: string; size: number; sheet: string | null } | null;
  mapping: Record<string, string | null>;
  fields: { key: string; label: string }[];
  reviews: { id: string; rowRef: string; kind: string; message: string; candidates: { personId: string }[]; choice: "match" | "new" | "skip" | null; personId: string | null }[];
  appFields: (ImportAppField & { categoryMapping: Record<string, string | null>; emptyRows: number; decision: { mode: "default"; value: string } | { mode: "skip" } | null })[];
  pendingRequired: string[];
  counts: { rows: number; created: number; updated: number; skipped: number; failed: number };
  applied: { batches: number; rows: number };
  createdAt: string | null;
  expiresAt: string | null;
}

const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const CHOICES = ["match", "new", "skip"] as const;

function decisionOf(v: unknown): ImportView["appFields"][number]["decision"] {
  const d = o(v);
  if (d.mode === "skip") return { mode: "skip" };
  if (d.mode === "default" && typeof d.value === "string" && d.value) return { mode: "default", value: d.value };
  return null;
}

/**
 * persons `GET /imports/:id` → a stable view for the import screen. Core's
 * job never carries rows (§20); anything unknown is dropped, nothing about a
 * person beyond ids reaches the browser through here.
 */
export function importView(job: Record<string, unknown>, ours: ImportAppField[], applied: { batches: number; rows: number } = { batches: 0, rows: 0 }): ImportView {
  const coreFields = new Map((Array.isArray(job.appFields) ? job.appFields : []).map((f) => [s(o(f).key) ?? "", o(f)]));
  const appFields = ours.map((f) => {
    const c = coreFields.get(f.key) ?? {};
    const mapping = o(c.categoryMapping ?? c.mapping);
    return {
      ...f,
      categoryMapping: Object.fromEntries(Object.entries(mapping).map(([raw, key]) => [raw, typeof key === "string" ? key : null])),
      emptyRows: n(c.emptyRows ?? c.unfilled),
      decision: decisionOf(c.decision),
    };
  });
  const declared = Array.isArray(job.pendingRequired) ? job.pendingRequired : Array.isArray(job.decisionsPending) ? job.decisionsPending : null;
  const pendingRequired = declared
    ? declared.filter((k): k is string => typeof k === "string")
    : appFields.filter((f) => f.required && f.emptyRows > 0 && !f.decision).map((f) => f.key);
  const counts = o(job.counts);
  const file = o(job.file);
  return {
    id: s(job.id) ?? s(job.importId) ?? s(job._id) ?? "",
    subject: subjectOfTargets(job.targets),
    status: s(job.status) ?? "analysing",
    steps: (Array.isArray(job.steps) ? job.steps : []).map((x) => ({ name: s(o(x).name) ?? "", done: n(o(x).done), total: n(o(x).total) })).filter((x) => x.name),
    file: s(file.name) ? { name: s(file.name)!, size: n(file.size), sheet: s(file.sheet) } : null,
    mapping: Object.fromEntries(Object.entries(o(job.mapping)).map(([col, field]) => [col, typeof field === "string" ? field : null])),
    fields: (Array.isArray(job.fields) ? job.fields : []).map((x) => ({ key: s(o(x).key) ?? "", label: s(o(x).label) ?? s(o(x).key) ?? "" })).filter((x) => x.key),
    reviews: (Array.isArray(job.reviews) ? job.reviews : []).map((x) => {
      const r = o(x);
      return {
        id: s(r.id) ?? "",
        rowRef: s(r.rowRef) ?? "",
        kind: s(r.kind) ?? "review",
        message: s(r.message) ?? s(r.reason) ?? "",
        candidates: (Array.isArray(r.candidates) ? r.candidates : []).map((cand) => ({ personId: s(o(cand).personId) ?? "" })).filter((cand) => cand.personId),
        choice: (CHOICES as readonly unknown[]).includes(r.choice) ? (r.choice as "match" | "new" | "skip") : null,
        personId: s(r.personId),
      };
    }).filter((r) => r.id),
    appFields,
    pendingRequired,
    counts: { rows: n(counts.rows), created: n(counts.created), updated: n(counts.updated), skipped: n(counts.skipped), failed: n(counts.failed) },
    applied,
    createdAt: s(job.createdAt),
    expiresAt: s(job.expiresAt),
  };
}

// ── decisions (PATCH) ───────────────────────────────────────────────────────

export type Decisions = {
  mapping?: Record<string, string | null>;
  reviews?: Record<string, { choice: "match" | "new" | "skip"; personId?: string }>;
  categories?: Record<string, Record<string, string | null>>;
  required?: Record<string, { mode: "default"; value: string } | { mode: "skip" }>;
};

/** Validates the browser's decisions against Acampa's app fields before they go to persons-api. */
export function parseDecisions(body: unknown, fields: ImportAppField[]): { ok: true; decisions: Decisions } | { ok: false; message: string } {
  const b = o(body);
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Decisões inválidas." };
  const out: Decisions = {};
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const isCat = (f: ImportAppField, v: string) => (f.categories ?? []).some((c) => c.key === v);
  if (b.mapping !== undefined) {
    const m = o(b.mapping);
    if (Object.values(m).some((v) => v !== null && typeof v !== "string")) return { ok: false, message: "Mapeamento de colunas inválido." };
    out.mapping = m as Record<string, string | null>;
  }
  if (b.reviews !== undefined) {
    const r: NonNullable<Decisions["reviews"]> = {};
    for (const [id, raw] of Object.entries(o(b.reviews))) {
      const d = o(raw);
      if (!(CHOICES as readonly unknown[]).includes(d.choice)) return { ok: false, message: "Escolha de revisão inválida." };
      if (d.choice === "match" && typeof d.personId !== "string") return { ok: false, message: "Escolha a pessoa já cadastrada." };
      r[id] = { choice: d.choice as "match" | "new" | "skip", ...(d.choice === "match" ? { personId: d.personId as string } : {}) };
    }
    out.reviews = r;
  }
  if (b.categories !== undefined) {
    const c: NonNullable<Decisions["categories"]> = {};
    for (const [key, raw] of Object.entries(o(b.categories))) {
      const f = byKey.get(key);
      if (!f || f.kind !== "category") return { ok: false, message: `Campo "${key}" não é uma categoria.` };
      const map: Record<string, string | null> = {};
      for (const [sheet, value] of Object.entries(o(raw))) {
        if (value !== null && (typeof value !== "string" || !isCat(f, value))) return { ok: false, message: `Opção inválida em "${key}".` };
        map[sheet] = value as string | null;
      }
      c[key] = map;
    }
    out.categories = c;
  }
  if (b.required !== undefined) {
    const r: NonNullable<Decisions["required"]> = {};
    for (const [key, raw] of Object.entries(o(b.required))) {
      const f = byKey.get(key);
      if (!f?.required) return { ok: false, message: `Campo "${key}" não é obrigatório.` };
      const d = o(raw);
      if (d.mode === "skip") r[key] = { mode: "skip" };
      else if (d.mode === "default" && typeof d.value === "string" && d.value.trim() && (f.kind === "text" ? d.value.length <= (TEXT_LIMITS[key] ?? 300) : isCat(f, d.value))) r[key] = { mode: "default", value: d.value.trim() };
      else return { ok: false, message: `Decisão inválida para "${key}".` };
    }
    out.required = r;
  }
  return { ok: true, decisions: out };
}

// ── applying batches to participants ────────────────────────────────────────

export interface BatchOutcome {
  rows: number;
  applied: number;
  skipped: number;
  unfilled: number;
}

/** One batch → `participants` (camp ops) of `campId`. Rows already stamped with this import are left alone. */
export async function applyBatch(importId: string, batch: ImportBatch, ctx: { campId: string; subject: ImportSubject | null }): Promise<BatchOutcome> {
  return withCamp(ctx.campId, async () => {
    const out: BatchOutcome = { rows: batch.rows.length, applied: 0, skipped: 0, unfilled: 0 };
    const [rooms, vehicles, teams, campersPerRoom, staffPerRoom] = await Promise.all([listBedrooms(), listTransports(), listTeams(), countCampersPerBedroom(), countStaffPerBedroom()]);
    const roomById = new Map(rooms.map((r) => [r._id, r]));
    const vehicleIds = new Set(vehicles.map((v) => v._id));
    const teamIds = new Set(teams.map((t) => t._id));
    const occupied = (id: string) => (campersPerRoom.get(id) ?? 0) + (staffPerRoom.get(id) ?? 0);
    let touched = false;
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
      if (current?.importId === importId) continue; // already applied (socket + webhook + reconciliation)
      const v = row.appFields;
      const patch: Record<string, unknown> = { importId };
      const text = (key: string) => {
        const t = (v[key] ?? "").trim();
        if (t) patch[key] = t.slice(0, TEXT_LIMITS[key] ?? 300);
      };
      const pick = (key: string, ok: (id: string) => boolean) => {
        const id = (v[key] ?? "").trim();
        if (!id) return;
        if (ok(id)) patch[key] = id;
        else out.unfilled++;
      };
      pick("transportation", (id) => vehicleIds.has(id));
      pick("team", (id) => teamIds.has(id));
      pick("bedroom", (id) => {
        const room = roomById.get(id);
        if (!room || (subject === "camper" && room.group === "staff")) return false;
        if (current?.bedroom === id) return true;
        // a full room is never overfilled by an import: the row keeps no room (counted as unfilled)
        if (occupied(id) >= bedroomCapacity(room)) return false;
        if (subject === "camper") campersPerRoom.set(id, (campersPerRoom.get(id) ?? 0) + 1);
        else staffPerRoom.set(id, (staffPerRoom.get(id) ?? 0) + 1);
        return true;
      });
      text("generalNotes");
      if (subject === "camper") {
        text("invitedBy");
        text("bedroomPreference");
      } else {
        pick("roomRole", (id) => (ROOM_ROLES as readonly string[]).includes(id));
      }
      if (subject === "camper") {
        if (current) await updateCamper(row.personId, patch as Partial<CamperData>);
        else await insertCamper(row.personId, { ...EMPTY_CAMPER, qrToken: randomUUID(), ...(patch as Partial<CamperData>) });
      } else {
        if (current) await updateStaff(row.personId, patch as Partial<StaffData>);
        else await insertStaff(row.personId, { ...EMPTY_STAFF, ...(patch as Partial<StaffData>) });
      }
      out.applied++;
      touched = true;
    }
    if (touched) publish(ctx.subject === "team" ? "staff" : "campers", "bedrooms", ...(ctx.subject === null ? (["staff"] as const) : []));
    return out;
  });
}

/** An import nobody here started (Mordomia, or before a restart): the person's live edition role says kid or team. */
async function subjectOfPerson(personId: string, campId: string): Promise<ImportSubject | null> {
  const roles = await editionRolesOf(personId, campId);
  if (roles.includes(PARTICIPANT_ROLE)) return "camper";
  if (roles.some((r) => r !== RESPONSIBLE_ROLE)) return "team";
  return null;
}

/** The camp of an edition (imports run on the active camp; an unknown edition = the active camp). */
export async function campOfEdition(editionId: string | null): Promise<string> {
  if (editionId) {
    const camp = (await listCamps()).find((c) => c.editionId === editionId);
    if (camp) return camp._id;
  }
  return activeCampId();
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
    ...(typeof m.batch === "number" ? { batch: m.batch } : {}),
    ...(Array.isArray(m.rows) ? { rows: m.rows } : {}),
  };
}

/** The importer's coordenação persons token, opened from their live session (null = they are gone: reconcile on their next GET). */
async function importerToken(t: Tracked): Promise<string | null> {
  const { findSession } = await import("./session");
  const { coordinationToken } = await import("./acting");
  const session = await findSession(t.sessionId);
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  try {
    return coordinationToken(session, PERSONS_RESOURCE);
  } catch {
    return null;
  }
}

/**
 * One message from dispatch (socket or webhook — the caller already
 * authenticated it). Progress → the importer's sockets; a batch → applied to
 * `participants`. A batch without rows (too big for dispatch) is read from
 * persons-api with the importer's token when we can, else it waits for the
 * reconciliation. Only for Acampa's own project.
 */
export async function handleAppMessage(msg: AppMessage, projectId: string): Promise<void> {
  if (msg.projectId && msg.projectId !== projectId) return;
  const t = trackedImport(msg.importId);
  const campId = t?.campId ?? activeCampId();
  if (t) {
    emitImportEvent(t.personId, t.campId, "import-progress", { importId: msg.importId, step: msg.step, done: msg.done, total: msg.total, status: msg.status, ...(msg.batch !== undefined ? { batch: msg.batch } : {}) });
    if (FINAL_STATUSES.has(msg.status)) tracked.get(msg.importId)!.finishedAt ??= Date.now();
  }
  if (msg.type !== "person-import.batch" || msg.batch === undefined) return;
  if (t?.applied.has(msg.batch)) return;
  let batch = msg.rows ? toImportBatch({ batch: msg.batch, rows: msg.rows }) : null;
  if (!batch && t) {
    const token = await importerToken(t);
    if (token) batch = await readBatch(token, msg.importId, msg.batch);
  }
  if (!batch) return; // reconciled later (GET by the importer / reconnect)
  const outcome = await applyBatch(msg.importId, batch, { campId, subject: t?.subject ?? null });
  if (t) {
    const live = tracked.get(msg.importId);
    live?.applied.add(msg.batch);
    if (live) live.appliedRows += outcome.applied;
    emitImportEvent(t.personId, t.campId, "import-batch", { importId: msg.importId, batch: msg.batch, ...outcome });
  }
  console.log(`[imports] ${msg.importId} batch ${msg.batch}: ${outcome.applied}/${outcome.rows} applied`);
}

async function readBatch(token: string, importId: string, batchNo: number): Promise<ImportBatch | null> {
  try {
    const page = await coreClient().importBatches(token, importId, { cursor: String(batchNo), limit: 1 });
    return page.items.find((b) => b.batch === batchNo) ?? null;
  } catch (err) {
    if (err instanceof IpalphaTokenRevoked || err instanceof IpalphaUnavailable || err instanceof IpalphaRejected) return null;
    throw err;
  }
}

/**
 * Reads every batch of the import from persons-api (the owner keeps results
 * until the import expires — decision 64) and applies the ones not applied
 * yet. Used on the importer's GET and after the app channel reconnects.
 */
export async function reconcileImport(importId: string, token: string, ctx: { campId: string; subject: ImportSubject | null; personId?: string; final?: boolean }): Promise<{ batches: number; rows: number }> {
  const t = tracked.get(importId);
  const startedAt = Date.now();
  let cursor: string | undefined;
  let batches = 0;
  let rows = 0;
  for (let guard = 0; guard < 500; guard++) {
    const page = await coreClient().importBatches(token, importId, { cursor, limit: 10 });
    for (const b of page.items) {
      batches++;
      rows += b.rows.length;
      if (t?.applied.has(b.batch)) continue;
      const outcome = await applyBatch(importId, b, ctx);
      t?.applied.add(b.batch);
      if (t) t.appliedRows += outcome.applied;
      if (ctx.personId && outcome.applied) emitImportEvent(ctx.personId, ctx.campId, "import-batch", { importId, batch: b.batch, ...outcome });
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  if (t) {
    t.lastReconciledAt = Date.now();
    // a finished import read to the end needs no other read (a later final message re-opens it once)
    if (ctx.final) t.finishedAt ??= startedAt;
  }
  return { batches, rows };
}

/** After the app channel (re)connects: reconcile every open import whose importer still has a live session. */
export async function reconcileOpenImports(): Promise<number> {
  let done = 0;
  for (const t of openImports()) {
    const token = await importerToken(t);
    if (!token) continue;
    try {
      await reconcileImport(t.importId, token, { campId: t.campId, subject: t.subject, personId: t.personId });
      done++;
    } catch (err) {
      console.warn(`[imports] reconcile ${t.importId} failed (${err instanceof Error ? err.message : "error"})`);
    }
  }
  return done;
}

/** How long a GET waits before reading the batches again (the screen re-GETs on every event). */
export const RECONCILE_EVERY_MS = 15_000;

export function reconcileDue(importId: string, status: string): boolean {
  const t = tracked.get(importId);
  if (!t) return status === "applying" || status === "done";
  if (FINAL_STATUSES.has(status)) {
    t.finishedAt ??= Date.now();
    return t.lastReconciledAt < t.finishedAt;
  }
  return status === "applying" && Date.now() - t.lastReconciledAt > RECONCILE_EVERY_MS;
}

export function appliedOf(importId: string): { batches: number; rows: number } {
  const t = tracked.get(importId);
  return { batches: t?.applied.size ?? 0, rows: t?.appliedRows ?? 0 };
}

// ── one queue for every app message (socket + webhook): batches never race each other ──

let queue: Promise<void> = Promise.resolve();
let queued = 0;
const QUEUE_MAX = 500;

/** Runs `handleAppMessage` in arrival order; never rejects (a failure is logged — reconciliation catches up). */
export function enqueueAppMessage(msg: AppMessage, projectId: string): Promise<void> {
  if (queued >= QUEUE_MAX) {
    console.warn("[imports] message queue full — dropped (reconciliation catches up)");
    return Promise.resolve();
  }
  queued++;
  const run = queue.then(() => handleAppMessage(msg, projectId)).catch((err) => {
    console.warn(`[imports] ${msg.importId} message failed (${err instanceof Error ? err.message : "error"}) — reconciliation catches up`);
  });
  queue = run.finally(() => {
    queued--;
  });
  return run;
}
