import { insertBedroom, listBedrooms } from "../models/bedrooms";
import { insertCamper, listCampers, updateCamper } from "../models/campers";
import { appendCategoryOption, insertCategory, listCategories, newOptionId, nextCategoryOrder } from "../models/categories";
import { insertInstruction, listInstructions, nextInstructionOrder } from "../models/instructions";
import { insertPrepSection, listPrepSections, nextPrepOrder } from "../models/preparation";
import { insertEvent, insertRole, listEvents, listRoles } from "../models/schedule";
import { getSettings, updateSettings } from "../models/settings";
import { insertStaff, listStaff, updateStaff } from "../models/staff";
import { insertTeam, listTeams } from "../models/teams";
import { insertTransport, listTransports } from "../models/transports";
import { activeCampId, withCamp } from "./campContext";
import { grantRole, type CoordinationTokens } from "./coreRegistration";
import { responsiblesOf } from "./members";
import { namesOf } from "./people";
import { coreClient } from "./ipalpha";
import { IpalphaRejected } from "./ipalpha/coreClient";
import { publish, type Collection as RealtimeCollection } from "./realtime";
import type {
  Bedroom,
  BusHelper,
  CampEvent,
  Camper,
  CamperSex,
  Category,
  CategoryOption,
  EventAssignment,
  InstructionDoc,
  ParentContact,
  PrepSection,
  RoomRole,
  ScheduleRole,
  Settings,
  Staff,
  Team,
  Transport,
} from "../types";

export const IMPORT_BLOCKS = ["categories", "teams", "bedrooms", "transports", "staff", "campers", "schedule", "docs", "settings"] as const;
export type ImportBlock = (typeof IMPORT_BLOCKS)[number];

export interface ImportOptions {
  blocks: ImportBlock[];
  /** coordenação tokens + the target edition: copied people get their memberships there (null = camp ops only) */
  core?: { tokens: CoordinationTokens; editionId: string } | null;
  camperIds?: string[];
  staffIds?: string[];
  withRoles: boolean;
  withAssignments: boolean;
  onMatch: "skip" | "update";
}

/** `membershipsFailed`: people copied whose membership in the target edition core refused (they need it in Oikos). */
export type BlockResult = { created: number; updated: number; skipped: number; membershipsFailed?: number };

/** A kid of another year (names live from core; `matched` = already in the ACTIVE camp — same person id). */
export interface CamperRow {
  id: string;
  name: string;
  sex: CamperSex | null;
  bedroom: string | null;
  team: string | null;
  matched: boolean;
}

export interface StaffRow {
  id: string;
  name: string;
  roomRole: RoomRole;
  bedroom: string | null;
  team: string | null;
  matched: boolean;
}

/** Accent/case-insensitive comparison key, e.g. "Ana Lúcia" → "ana lucia". */
/** accent / case / punctuation-insensitive key ("Ônibus  Azul!" → "onibus azul") */
export const normalizeKey = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim();

/** The `idMap` entry for `oldId` when this run already created/matched it; otherwise the pre-computed soft match; otherwise null. */
export function remapLink(oldId: string | null, idMap: Map<string, string>, softMatchIndex: Map<string, string>): string | null {
  if (!oldId) return null;
  return idMap.get(oldId) ?? softMatchIndex.get(oldId) ?? null;
}

const ALWAYS_STRIP = new Set(["_id", "campId", "createdAt", "updatedAt", "importId"]);

/** A fresh, camp-neutral copy of `doc`: `_id`, `campId`, timestamps, `importId` and every `aiReview*` field are always dropped, plus whatever `extraStrip` names. */
export function stripForCopy(doc: Record<string, unknown>, extraStrip: string[] = []): Record<string, unknown> {
  const drop = new Set([...ALWAYS_STRIP, ...extraStrip]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (drop.has(key) || key.startsWith("aiReview")) continue;
    out[key] = value;
  }
  return out;
}

export interface SettingsRemap {
  /** a person (same id across camps) → kept only when on the target camp's team */
  person: (personId: string) => string | null;
  vehicle: (oldId: string) => string | null;
}

/** The importable subset of `source`: never windows, drafts, the reminder, `galleryPublished` or `wizardMode`; person / vehicle references that don't resolve are dropped. */
export function settingsToImport(source: Settings, remap: SettingsRemap): Partial<Settings> {
  const busHelpers: BusHelper[] = source.busHelpers.helpers
    .map((h) => ({ personId: remap.person(h.personId), vehicleId: remap.vehicle(h.vehicleId) }))
    .filter((h): h is BusHelper => !!h.personId && !!h.vehicleId);
  const parentContacts: ParentContact[] = source.parentContacts
    .map((p) => ({ ...p, personId: remap.person(p.personId) }))
    .filter((p): p is ParentContact => !!p.personId);
  return {
    checkinLocations: source.checkinLocations,
    notifications: source.notifications,
    busHelpers: { helpers: busHelpers },
    parentContacts,
  };
}

function buildSoftMatchIndex<T extends { _id: string }>(source: T[], target: T[], keyFn: (t: T) => string | null): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const t of target) {
    const key = keyFn(t);
    if (key && !byKey.has(key)) byKey.set(key, t._id);
  }
  const result = new Map<string, string>();
  for (const s of source) {
    const key = keyFn(s);
    const targetId = key ? byKey.get(key) : undefined;
    if (targetId) result.set(s._id, targetId);
  }
  return result;
}

function transportMatchKey(t: Pick<Transport, "kind" | "number" | "name">): string {
  return t.kind === "bus" ? `bus:${t.number ?? ""}` : `car:${normalizeKey(t.name ?? "")}`;
}

interface CategoryOptionContext {
  idMap: Map<string, string>;
  sourceOptionInfo: Map<string, { key: string; label: string }>;
  targetCategoriesByKey: Map<string, Category>;
}

async function remapCategoryOption(oldId: string | null, ctx: CategoryOptionContext): Promise<string | null> {
  if (!oldId) return null;
  const mapped = ctx.idMap.get(oldId);
  if (mapped) return mapped;
  const info = ctx.sourceOptionInfo.get(oldId);
  if (!info) return null;
  const targetCat = ctx.targetCategoriesByKey.get(info.key);
  if (!targetCat) return null;
  const labelKey = normalizeKey(info.label);
  const existing = targetCat.options.find((o) => normalizeKey(o.label) === labelKey);
  if (existing) {
    ctx.idMap.set(oldId, existing.id);
    return existing.id;
  }
  const draftOption: CategoryOption = { id: newOptionId(), label: info.label, order: targetCat.options.length, active: true, draft: true };
  await appendCategoryOption(targetCat._id, draftOption);
  targetCat.options.push(draftOption);
  ctx.idMap.set(oldId, draftOption.id);
  return draftOption.id;
}

async function remapCategoryOptions(oldIds: string[], ctx: CategoryOptionContext): Promise<string[]> {
  const out: string[] = [];
  for (const id of oldIds) {
    const mapped = await remapCategoryOption(id, ctx);
    if (mapped) out.push(mapped);
  }
  return out;
}

async function importCategories(sourceCategories: Category[], idMap: Map<string, string>, targetCategoriesByKey: Map<string, Category>): Promise<BlockResult> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const src of sourceCategories) {
    const existing = targetCategoriesByKey.get(src.key);
    if (!existing) {
      const options: CategoryOption[] = src.options.map((o, i) => ({ id: newOptionId(), label: o.label, order: i, active: o.active }));
      const createdCat = await insertCategory({ key: src.key, name: src.name, emoji: src.emoji, description: src.description, appliesTo: src.appliesTo, selection: src.selection, options, order: await nextCategoryOrder() });
      for (const [i, o] of src.options.entries()) idMap.set(o.id, options[i]!.id);
      targetCategoriesByKey.set(src.key, createdCat);
      created++;
      continue;
    }
    let changed = false;
    for (const opt of src.options) {
      const labelKey = normalizeKey(opt.label);
      const match = existing.options.find((o) => normalizeKey(o.label) === labelKey);
      if (match) {
        idMap.set(opt.id, match.id);
        continue;
      }
      const newOpt: CategoryOption = { id: newOptionId(), label: opt.label, order: existing.options.length, active: opt.active };
      await appendCategoryOption(existing._id, newOpt);
      existing.options.push(newOpt);
      idMap.set(opt.id, newOpt.id);
      changed = true;
    }
    if (changed) updated++;
    else skipped++;
  }
  return { created, updated, skipped };
}

async function importTeams(sourceTeams: Team[], idMap: Map<string, string>, target: Team[]): Promise<BlockResult> {
  let created = 0;
  let skipped = 0;
  const byKey = new Map(target.map((t) => [normalizeKey(t.name), t]));
  for (const src of sourceTeams) {
    const existing = byKey.get(normalizeKey(src.name));
    if (existing) {
      idMap.set(src._id, existing._id);
      skipped++;
      continue;
    }
    const createdTeam = await insertTeam({ name: src.name, color: src.color, order: src.order });
    idMap.set(src._id, createdTeam._id);
    byKey.set(normalizeKey(src.name), createdTeam);
    created++;
  }
  return { created, updated: 0, skipped };
}

async function importBedrooms(sourceBedrooms: Bedroom[], idMap: Map<string, string>, target: Bedroom[]): Promise<BlockResult> {
  let created = 0;
  let skipped = 0;
  const byKey = new Map(target.map((b) => [normalizeKey(b.name), b]));
  for (const src of sourceBedrooms) {
    const existing = byKey.get(normalizeKey(src.name));
    if (existing) {
      idMap.set(src._id, existing._id);
      skipped++;
      continue;
    }
    const createdBedroom = await insertBedroom({ name: src.name, group: src.group, bunkBeds: src.bunkBeds, singleBeds: src.singleBeds, notes: src.notes });
    idMap.set(src._id, createdBedroom._id);
    byKey.set(normalizeKey(src.name), createdBedroom);
    created++;
  }
  return { created, updated: 0, skipped };
}

async function importTransports(sourceTransports: Transport[], idMap: Map<string, string>, target: Transport[]): Promise<BlockResult> {
  let created = 0;
  let skipped = 0;
  const byKey = new Map(target.map((t) => [transportMatchKey(t), t]));
  for (const src of sourceTransports) {
    const existing = byKey.get(transportMatchKey(src));
    if (existing) {
      idMap.set(src._id, existing._id);
      skipped++;
      continue;
    }
    const createdTransport = await insertTransport({ kind: src.kind, name: src.name, color: src.color, number: src.number, capacity: src.capacity, order: src.order });
    idMap.set(src._id, createdTransport._id);
    byKey.set(transportMatchKey(createdTransport), createdTransport);
    created++;
  }
  return { created, updated: 0, skipped };
}

interface SoftIndexes {
  team: Map<string, string>;
  bedroom: Map<string, string>;
  transport: Map<string, string>;
}

/**
 * People are the SAME IPAlpha person in every year (person id), so a copy is a
 * camp-ops row in the target camp + (with the coordenação tokens) the
 * membership of the target edition: `equipe` for the team, `participante`
 * (naming the source year's responsáveis as involved) + their `responsavel`
 * for the kids. A refused membership is counted, never fatal.
 */
async function importStaff(sourceStaff: Staff[], opts: ImportOptions, idMap: Map<string, string>, softIdx: SoftIndexes): Promise<BlockResult> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let membershipsFailed = 0;
  const pool = opts.staffIds?.length ? sourceStaff.filter((s) => opts.staffIds!.includes(s._id)) : sourceStaff.filter((s) => s.active);
  const target = new Set((await listStaff({ includeDraft: true })).map((s) => s._id));
  for (const src of pool) {
    const ops = { roomRole: src.roomRole, generalNotes: src.generalNotes, bedroom: remapLink(src.bedroom, idMap, softIdx.bedroom), team: remapLink(src.team, idMap, softIdx.team), transportation: remapLink(src.transportation, idMap, softIdx.transport) };
    if (target.has(src._id)) {
      if (opts.onMatch === "update") {
        await updateStaff(src._id, { roomRole: src.roomRole, generalNotes: src.generalNotes });
        updated++;
      } else skipped++;
      continue;
    }
    if (opts.core && !(await grantRole(opts.core.tokens, src._id, "equipe", opts.core.editionId))) membershipsFailed++;
    await insertStaff(src._id, { ...ops, active: true, importId: null });
    target.add(src._id);
    created++;
  }
  return { created, updated, skipped, membershipsFailed };
}

async function importCampers(sourceCampers: Camper[], opts: ImportOptions, idMap: Map<string, string>, softIdx: SoftIndexes, catCtx: CategoryOptionContext, sourceCampId: string): Promise<BlockResult> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let membershipsFailed = 0;
  const pool = opts.camperIds?.length ? sourceCampers.filter((c) => opts.camperIds!.includes(c._id)) : sourceCampers;
  const target = new Set((await listCampers({ includeDraft: true })).map((k) => k._id));
  const responsibles = opts.core ? await withCamp(sourceCampId, () => responsiblesOf(pool.map((k) => k._id), sourceCampId)) : new Map<string, string[]>();
  for (const src of pool) {
    if (target.has(src._id)) {
      if (opts.onMatch === "update") {
        await updateCamper(src._id, { invitedBy: src.invitedBy, generalNotes: src.generalNotes, bedroomPreference: src.bedroomPreference });
        updated++;
      } else skipped++;
      continue;
    }
    if (opts.core) {
      const parents = responsibles.get(src._id) ?? [];
      try {
        await coreClient().addMembership(opts.core.tokens.projects, { personId: src._id, role: "participante", editionId: opts.core.editionId, involved: parents.map((personId) => ({ personId, purpose: "responsible" as const, kinds: [] })) });
        for (const parent of parents) await grantRole(opts.core.tokens, parent, "responsavel", opts.core.editionId);
      } catch (err) {
        if (!(err instanceof IpalphaRejected)) throw err;
        membershipsFailed++;
      }
    }
    await insertCamper(src._id, {
      invitedBy: src.invitedBy,
      generalNotes: src.generalNotes,
      bedroomPreference: src.bedroomPreference,
      qrToken: src.qrToken,
      caretakerId: null,
      bedroom: null,
      bed: await remapCategoryOption(src.bed, catCtx),
      team: remapLink(src.team, idMap, softIdx.team),
      transportation: remapLink(src.transportation, idMap, softIdx.transport),
      importId: null,
    });
    target.add(src._id);
    created++;
  }
  return { created, updated, skipped, membershipsFailed };
}

async function importRoles(sourceRoles: ScheduleRole[], idMap: Map<string, string>): Promise<BlockResult> {
  let created = 0;
  let skipped = 0;
  const target = await listRoles();
  const byKey = new Map(target.map((r) => [normalizeKey(r.name), r]));
  for (const src of sourceRoles) {
    const existing = byKey.get(normalizeKey(src.name));
    if (existing) {
      idMap.set(src._id, existing._id);
      skipped++;
      continue;
    }
    const createdRole = await insertRole({
      name: src.name,
      emoji: src.emoji,
      instructions: src.instructions,
      preparation: src.preparation,
      forRoomRoles: src.forRoomRoles,
      hasDetail: src.hasDetail,
      detailFromTeam: src.detailFromTeam,
      detailPlaceholder: src.detailPlaceholder,
    });
    idMap.set(src._id, createdRole._id);
    byKey.set(normalizeKey(src.name), createdRole);
    created++;
  }
  return { created, updated: 0, skipped };
}

function eventKey(e: Pick<CampEvent, "date" | "startTime" | "title">): string {
  return `${e.date}|${e.startTime}|${normalizeKey(e.title)}`;
}

async function importEvents(sourceEvents: CampEvent[], idMap: Map<string, string>, opts: ImportOptions, onTeam: Set<string>): Promise<BlockResult> {
  let created = 0;
  let skipped = 0;
  const target = await listEvents();
  const existingKeys = new Set(target.map(eventKey));
  for (const src of sourceEvents) {
    if (existingKeys.has(eventKey(src))) {
      skipped++;
      continue;
    }
    const roles = opts.withRoles ? src.roles.map((r) => idMap.get(r)).filter((r): r is string => !!r) : [];
    const assignments: EventAssignment[] = opts.withAssignments
      ? src.assignments.flatMap((a) => {
          const staffId = onTeam.has(a.staffId) ? a.staffId : null;
          const roleId = idMap.get(a.roleId);
          return staffId && roleId ? [{ staffId, roleId, detail: a.detail, detailColor: a.detailColor }] : [];
        })
      : [];
    await insertEvent({ date: src.date, title: src.title, emoji: src.emoji, startTime: src.startTime, endTime: src.endTime, notes: src.notes, roles, visibleToParents: src.visibleToParents, assignments });
    existingKeys.add(eventKey(src));
    created++;
  }
  return { created, updated: 0, skipped };
}

async function importInstructions(sourceDocs: InstructionDoc[]): Promise<BlockResult> {
  let created = 0;
  let skipped = 0;
  const target = await listInstructions();
  const existing = new Set(target.map((d) => normalizeKey(d.title)));
  for (const src of sourceDocs) {
    if (existing.has(normalizeKey(src.title))) {
      skipped++;
      continue;
    }
    await insertInstruction({ title: src.title, emoji: src.emoji, audience: src.audience, content: src.content, order: await nextInstructionOrder() });
    existing.add(normalizeKey(src.title));
    created++;
  }
  return { created, updated: 0, skipped };
}

async function importPrepSections(sourceSections: PrepSection[]): Promise<BlockResult> {
  let created = 0;
  let skipped = 0;
  const target = await listPrepSections();
  const existing = new Set(target.map((s) => normalizeKey(s.title)));
  for (const src of sourceSections) {
    if (existing.has(normalizeKey(src.title))) {
      skipped++;
      continue;
    }
    await insertPrepSection({ title: src.title, emoji: src.emoji, audiences: src.audiences, content: src.content, order: await nextPrepOrder() });
    existing.add(normalizeKey(src.title));
    created++;
  }
  return { created, updated: 0, skipped };
}

/** Copies the selected blocks of `sourceCampId` into the current (request) camp; every written document gets a brand-new id. */
export async function importFromCamp(sourceCampId: string, opts: ImportOptions): Promise<Partial<Record<ImportBlock, BlockResult>>> {
  const blocks = new Set(opts.blocks);
  const idMap = new Map<string, string>();
  const results: Partial<Record<ImportBlock, BlockResult>> = {};
  const touched = new Set<RealtimeCollection>();

  const source = await withCamp(sourceCampId, async () => ({
    categories: await listCategories(),
    teams: await listTeams(true),
    bedrooms: await listBedrooms({ includeDraft: false }),
    transports: await listTransports(true),
    staff: await listStaff({ includeDraft: false }),
    campers: await listCampers(),
    roles: await listRoles(),
    events: await listEvents(),
    instructions: await listInstructions(),
    prepSections: await listPrepSections(),
    settings: await getSettings(),
  }));

  const [targetTeams, targetBedrooms, targetTransports, targetCategories] = await Promise.all([listTeams(true), listBedrooms({ includeDraft: false }), listTransports(true), listCategories()]);

  const softIdx: SoftIndexes = {
    team: buildSoftMatchIndex(source.teams, targetTeams, (t) => normalizeKey(t.name)),
    bedroom: buildSoftMatchIndex(source.bedrooms, targetBedrooms, (b) => normalizeKey(b.name)),
    transport: buildSoftMatchIndex(source.transports, targetTransports, transportMatchKey),
  };

  const targetCategoriesByKey = new Map(targetCategories.map((c) => [c.key, c]));
  const sourceOptionInfo = new Map<string, { key: string; label: string }>();
  for (const cat of source.categories) for (const opt of cat.options) sourceOptionInfo.set(opt.id, { key: cat.key, label: opt.label });
  const catCtx: CategoryOptionContext = { idMap, sourceOptionInfo, targetCategoriesByKey };

  if (blocks.has("categories")) {
    results.categories = await importCategories(source.categories, idMap, targetCategoriesByKey);
    touched.add("categories");
  }
  if (blocks.has("teams")) {
    results.teams = await importTeams(source.teams, idMap, targetTeams);
    touched.add("teams");
  }
  if (blocks.has("bedrooms")) {
    results.bedrooms = await importBedrooms(source.bedrooms, idMap, targetBedrooms);
    touched.add("bedrooms");
  }
  if (blocks.has("transports")) {
    results.transports = await importTransports(source.transports, idMap, targetTransports);
    touched.add("transports");
  }
  if (blocks.has("staff")) {
    results.staff = await importStaff(source.staff, opts, idMap, softIdx);
    touched.add("staff");
  }
  if (blocks.has("campers")) {
    results.campers = await importCampers(source.campers, opts, idMap, softIdx, catCtx, sourceCampId);
    touched.add("campers");
  }
  if (blocks.has("schedule")) {
    const rolesResult = opts.withRoles ? await importRoles(source.roles, idMap) : { created: 0, updated: 0, skipped: 0 };
    const onTeam = new Set((await listStaff({ includeDraft: true })).map((s) => s._id));
    const eventsResult = await importEvents(source.events, idMap, opts, onTeam);
    results.schedule = { created: rolesResult.created + eventsResult.created, updated: 0, skipped: rolesResult.skipped + eventsResult.skipped };
    touched.add("roles");
    touched.add("events");
  }
  if (blocks.has("docs")) {
    const instructionsResult = await importInstructions(source.instructions);
    const prepResult = await importPrepSections(source.prepSections);
    results.docs = { created: instructionsResult.created + prepResult.created, updated: 0, skipped: instructionsResult.skipped + prepResult.skipped };
    touched.add("instructions");
    touched.add("preparation");
  }
  if (blocks.has("settings")) {
    const onTeam = new Set((await listStaff({ includeDraft: true })).map((s) => s._id));
    const remap: SettingsRemap = {
      person: (personId) => (onTeam.has(personId) ? personId : null),
      vehicle: (oldId) => remapLink(oldId, idMap, softIdx.transport),
    };
    await updateSettings(settingsToImport(source.settings, remap));
    results.settings = { created: 0, updated: 1, skipped: 0 };
    touched.add("settings");
  }

  if (touched.size) publish(...touched);
  return results;
}

/** Counts per importable block of `campId`, run in its own context; `schedule`/`docs` sum their breakdown (`roles`+`events`, `instructions`+`prepSections`). */
export async function campSummary(campId: string): Promise<Record<ImportBlock | "roles" | "events" | "instructions" | "prepSections", number>> {
  return withCamp(campId, async () => {
    const [categories, teams, bedrooms, transports, staff, campers, roles, events, instructions, prepSections] = await Promise.all([
      listCategories(),
      listTeams(true),
      listBedrooms({ includeDraft: true }),
      listTransports(true),
      listStaff({ includeDraft: true }),
      listCampers(),
      listRoles(),
      listEvents(),
      listInstructions(),
      listPrepSections(),
    ]);
    return {
      categories: categories.length,
      teams: teams.length,
      bedrooms: bedrooms.length,
      transports: transports.length,
      staff: staff.length,
      campers: campers.length,
      schedule: roles.length + events.length,
      docs: instructions.length + prepSections.length,
      settings: 1,
      roles: roles.length,
      events: events.length,
      instructions: instructions.length,
      prepSections: prepSections.length,
    };
  });
}

/** Kids of `campId`, filtered by `q` (name, live from core); `matched` = the same person is already in the ACTIVE camp. */
export async function searchCampCampers(campId: string, q: string, limit = 50): Promise<CamperRow[]> {
  const [sourceCampers, sourceBedrooms, sourceTeams] = await withCamp(campId, () => Promise.all([listCampers(), listBedrooms({ includeDraft: true }), listTeams(true)]));
  const bedroomName = new Map(sourceBedrooms.map((b) => [b._id, b.name]));
  const teamName = new Map(sourceTeams.map((t) => [t._id, t.name]));
  const active = new Set((await withCamp(activeCampId(), () => listCampers({ includeDraft: true }))).map((k) => k._id));
  const names = await namesOf(sourceCampers.map((k) => k._id));
  const query = normalizeKey(q);
  return sourceCampers
    .map((k) => ({ k, name: names.get(k._id)?.name ?? "" }))
    .filter(({ name }) => !query || normalizeKey(name).includes(query))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .slice(0, limit)
    .map(({ k, name }) => ({ id: k._id, name, sex: names.get(k._id)?.sex ?? null, bedroom: k.bedroom ? bedroomName.get(k.bedroom) ?? null : null, team: k.team ? teamName.get(k.team) ?? null : null, matched: active.has(k._id) }));
}

/** Team of `campId`, filtered by `q` (name, live); `matched` = already on the ACTIVE camp's team. */
export async function searchCampStaff(campId: string, q: string, limit = 50): Promise<StaffRow[]> {
  const [sourceStaff, sourceBedrooms, sourceTeams] = await withCamp(campId, () => Promise.all([listStaff({ includeDraft: true }), listBedrooms({ includeDraft: true }), listTeams(true)]));
  const bedroomName = new Map(sourceBedrooms.map((b) => [b._id, b.name]));
  const teamName = new Map(sourceTeams.map((t) => [t._id, t.name]));
  const active = new Set((await withCamp(activeCampId(), () => listStaff({ includeDraft: true }))).map((s) => s._id));
  const names = await namesOf(sourceStaff.map((s) => s._id));
  const query = normalizeKey(q);
  return sourceStaff
    .map((s) => ({ s, name: names.get(s._id)?.name ?? "" }))
    .filter(({ name }) => !query || normalizeKey(name).includes(query))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .slice(0, limit)
    .map(({ s, name }) => ({ id: s._id, name, roomRole: s.roomRole, bedroom: s.bedroom ? bedroomName.get(s.bedroom) ?? null : null, team: s.team ? teamName.get(s.team) ?? null : null, matched: active.has(s._id) }));
}
