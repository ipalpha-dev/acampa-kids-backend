import { campEditionId, roleToken } from "./acting";
import { currentCampId } from "./campContext";
import { coreClient } from "./ipalpha";
import { IpalphaRejected, NAMES_BATCH_MAX, PERSONS_RESOURCE, type HealthBlock, type HealthTagFilter, type PersonName } from "./ipalpha/coreClient";
import { currentViewer } from "./viewer";
import { EMPTY_HEALTH, type HealthInfo, type Medication, type Session } from "../types";

/**
 * Person data at the moment of use (CONTRACTS §15, decisions 22/31, LGPD):
 *
 *   names    the REQUESTER's acting role token (the viewer, services/viewer.ts), ≤ 200 ids per call, logged by
 *            persons-api per person. Core answers only the people that role may see (roles policy
 *            `seesPersonsOf`; leaders / directors see everyone) — others are silently absent, and with no
 *            viewer (timers) there are no names. Request-scoped only — nothing cached.
 *   health   the ACTING role token (persons-api role rules decide), logged.
 *   counts   the acting role token on the count endpoint (anonymized, not logged).
 *
 * Nothing returned here is ever written to Mongo or to a log line.
 */

export const PAGE_MAX = NAMES_BATCH_MAX;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Names of the given project members the session may see (unknown / not visible ids are simply absent; no session → none). */
export async function namesOf(personIds: readonly string[], session: Session | null = currentViewer()): Promise<Map<string, PersonName>> {
  const unique = [...new Set(personIds.filter(Boolean))];
  const out = new Map<string, PersonName>();
  if (unique.length === 0 || !session) return out;
  const token = roleToken(session, PERSONS_RESOURCE);
  // the camp's edition (a history year reads its own memberships); none known → core's edition in effect
  const editionId = (await campEditionId(currentCampId(), session)) ?? undefined;
  try {
    const pages = await Promise.all(chunks(unique, NAMES_BATCH_MAX).map((ids) => coreClient().names(token, ids, editionId)));
    for (const page of pages) for (const p of page) out.set(p.personId, p);
  } catch (err) {
    if (err instanceof IpalphaRejected && err.status === 403) return out;
    throw err;
  }
  return out;
}

/** One name ("" when core does not know the id or the session may not see it). */
export async function nameOf(personId: string, session: Session | null = currentViewer()): Promise<string> {
  return (await namesOf([personId], session)).get(personId)?.name ?? "";
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** `items` with `name` / `nickname` merged from core (one paged batch per 200). */
export async function withNames<T extends { id: string }>(items: T[]): Promise<(T & { name: string; nickname: string | null; sex: "F" | "M" | null })[]> {
  const names = await namesOf(items.map((i) => i.id));
  return items.map((i) => ({ ...i, name: names.get(i.id)?.name ?? "", nickname: names.get(i.id)?.nickname ?? null, sex: names.get(i.id)?.sex ?? null }));
}

function str(v: unknown, max = 2000): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** persons-api `health` block → Acampa's HealthInfo (missing fields default empty). */
export function toHealth(v: unknown): HealthInfo {
  if (!v || typeof v !== "object") return { ...EMPTY_HEALTH };
  const o = v as Record<string, unknown>;
  const meds: Medication[] = Array.isArray(o.medications)
    ? o.medications
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .map((m) => ({ name: str(m.name, 100), dose: str(m.dose, 60), times: strs(m.times), asNeeded: m.asNeeded === true, notes: str(m.notes, 300) }))
        .filter((m) => m.name)
    : [];
  return {
    allergies: strs(o.allergies),
    drugAllergies: strs(o.drugAllergies),
    healthIssues: strs(o.healthIssues),
    neurodivergent: o.neurodivergent === true,
    medications: meds,
    foodRestrictions: str(o.foodRestrictions, 300),
    healthNotes: str(o.healthNotes),
    weightKg: typeof o.weightKg === "number" ? o.weightKg : null,
    insurance: str(o.insurance, 60),
    insuranceCard: str(o.insuranceCard, 60),
  };
}

/** Is there anything in the health block? (drives the neutral ♥ — decision 31) */
export function hasHealthInfo(h: HealthInfo): boolean {
  return h.allergies.length > 0 || h.drugAllergies.length > 0 || h.healthIssues.length > 0 || h.neurodivergent || h.medications.length > 0 || !!h.foodRestrictions.trim() || !!h.healthNotes.trim();
}

/** The kind / storage field of health in persons-api. */
export const MEDICAL_KIND = "medical";

/**
 * Health of one person with the acting role token. `null` when the role may
 * not read it (403) or the person has none (404) — role rules decide in core.
 */
export async function readHealth(token: string, personId: string): Promise<HealthInfo | null> {
  try {
    return toHealth(await coreClient().readData(token, personId, MEDICAL_KIND));
  } catch (err) {
    if (err instanceof IpalphaRejected && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

/**
 * Health of one person + whether the role was refused (403). `health` is null
 * when there is none (404) or the role may not read it — the caller tells a
 * family "não disponível para o seu perfil" apart from "nada informado".
 */
export async function readHealthState(token: string, personId: string): Promise<{ health: HealthInfo | null; forbidden: boolean }> {
  try {
    return { health: toHealth(await coreClient().readData(token, personId, MEDICAL_KIND)), forbidden: false };
  } catch (err) {
    if (err instanceof IpalphaRejected && err.status === 403) return { health: null, forbidden: true };
    if (err instanceof IpalphaRejected && err.status === 404) return { health: null, forbidden: false };
    throw err;
  }
}

/**
 * The current block BEFORE a write: empty when the person has none yet (404);
 * a refusal (403) is thrown — a block we could not read is never overwritten
 * (writing `patch` over an empty base would erase what the family told us).
 */
export async function readHealthForWrite(token: string, personId: string): Promise<HealthInfo> {
  try {
    return toHealth(await coreClient().readData(token, personId, MEDICAL_KIND));
  } catch (err) {
    if (err instanceof IpalphaRejected && err.status === 404) return { ...EMPTY_HEALTH };
    throw err;
  }
}

/** Health of many people, a few calls at a time (each read is logged by persons-api for its owner). */
export async function readHealthMany(token: string, personIds: string[], concurrency = 8): Promise<Map<string, HealthInfo>> {
  const out = new Map<string, HealthInfo>();
  for (const batch of chunks([...new Set(personIds)], concurrency)) {
    const results = await Promise.all(batch.map(async (id) => [id, await readHealth(token, id)] as const));
    for (const [id, h] of results) if (h) out.set(id, h);
  }
  return out;
}

/** Writes a health patch (merged over the current block) with the acting role token. */
export async function writeHealth(token: string, personId: string, patch: Partial<HealthInfo>, current?: HealthInfo | null): Promise<HealthInfo> {
  const base = current ?? (await readHealthForWrite(token, personId));
  const next: HealthBlock = { ...base, ...patch };
  return toHealth(await coreClient().writeData(token, personId, MEDICAL_KIND, next));
}

/**
 * A queued AI result over the person's current block: lists are unioned, an
 * empty text never erases one, a new text is appended when it is not already
 * there (the AI never removes what a family or the medical team wrote).
 */
export function mergeHealth(current: HealthInfo, patch: Partial<HealthInfo>): Partial<HealthInfo> {
  const out: Partial<HealthInfo> = {};
  for (const f of ["allergies", "drugAllergies", "healthIssues"] as const) if (patch[f]) out[f] = [...new Set([...current[f], ...patch[f]!])];
  if (patch.neurodivergent) out.neurodivergent = true;
  if (patch.medications?.length) {
    const known = new Set(current.medications.map((m) => m.name.toLocaleLowerCase("pt-BR")));
    out.medications = [...current.medications, ...patch.medications.filter((m) => !known.has(m.name.toLocaleLowerCase("pt-BR")))];
  }
  for (const f of ["foodRestrictions", "healthNotes", "insurance", "insuranceCard"] as const) {
    const add = (patch[f] ?? "").trim();
    if (!add) continue;
    out[f] = current[f].includes(add) ? current[f] : [current[f], add].filter(Boolean).join(" ");
  }
  if (patch.weightKg != null && current.weightKg == null) out.weightKg = patch.weightKg;
  return out;
}

/**
 * Health-tag counts for the list chips (anonymized, not logged — decisions 22/56):
 * core counts the members of a project ROLE (+ edition) the acting role may count; no person ids are sent.
 */
export async function healthCounts(token: string, role: string, filters: HealthTagFilter, editionId?: string | null): Promise<{ total: number; byTag: Record<string, number> }> {
  return coreClient().count(token, { role, ...(editionId ? { editionId } : {}), filters: { healthTags: filters } });
}

/**
 * The neutral ♥ of a list page (decision 69, §23): has each person ANY health
 * info? A light flag read with the acting role token — never the medical block
 * itself (core logs it as a basic-register view). ≤ 200 per call (paged here).
 */
export async function healthFlagsOf(token: string, personIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const ids of chunks([...new Set(personIds.filter(Boolean))], NAMES_BATCH_MAX)) {
    for (const [id, flag] of await coreClient().healthFlags(token, ids)) out.set(id, flag);
  }
  return out;
}

/** Does `h` match a "field:value" health tag filter (`allergies:<optionId>`, `medications`, `neurodivergent`, `foodRestrictions`)? */
export function matchesHealthTag(h: HealthInfo, tag: string): boolean {
  const [field, value] = tag.split(":", 2);
  switch (field) {
    case "allergies":
    case "drugAllergies":
    case "healthIssues":
      return value ? h[field].includes(value) : h[field].length > 0;
    case "medications":
      return h.medications.length > 0;
    case "neurodivergent":
      return h.neurodivergent;
    case "foodRestrictions":
      return !!h.foodRestrictions.trim();
    default:
      return false;
  }
}

/** "field:value" → the count endpoint filter. */
export function tagFilter(tag: string): HealthTagFilter | null {
  const [field, value] = tag.split(":", 2);
  if ((field === "allergies" || field === "drugAllergies" || field === "healthIssues") && value) return { [field]: [value] };
  if (field === "medications" || field === "neurodivergent" || field === "foodRestrictions") return { [field]: true };
  return null;
}

/** Decodes an opaque list cursor (an offset) — invalid = start. */
export function decodeCursor(cursor: string | undefined | null): number {
  const n = Number(cursor ? Buffer.from(cursor, "base64url").toString("utf8") : 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

/** One page of `items` (cursor = offset). */
export function pageOf<T>(items: T[], cursor: string | undefined | null, limit: number): { items: T[]; nextCursor: string | null } {
  const start = decodeCursor(cursor);
  const size = Math.max(1, Math.min(PAGE_MAX, Math.floor(limit) || 50));
  const slice = items.slice(start, start + size);
  return { items: slice, nextCursor: start + size < items.length ? encodeCursor(start + size) : null };
}

/** Accent / case-insensitive "contains" for the name filter. */
export function nameMatches(name: string, q: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR");
  return norm(name).includes(norm(q.trim()));
}
