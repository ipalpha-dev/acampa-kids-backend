import { getDb } from "../db";
import type { CamperCheckin, CoreRole } from "../types";
import { ensureIndex } from "../services/indexes";

/**
 * `participants` (CONTRACTS §15, approved shape): one row per person per camp
 * — kids (`kind: "camper"`) and the team (`kind: "team"`) — holding ONLY camp
 * operations keyed by the IPAlpha `personId`. Names, birth dates, documents,
 * guardians, contacts and health live in persons-api / projects-api and are
 * read at the moment of use. Scoped per camp by the `Db` wrapper (campId).
 */
export const PARTICIPANTS = "participants";

export type ParticipantKind = "camper" | "team";

export function toCheckin(v: unknown): CamperCheckin | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!(o.at instanceof Date)) return null;
  return { at: o.at, byPersonId: (o.byPersonId as string) ?? "", byRole: (o.byRole as CoreRole) ?? "equipe", ...(typeof o.note === "string" && o.note ? { note: o.note } : {}) };
}

/** The base fields every participant row carries (see ParticipantBase in types.ts). */
export function baseOf(doc: Record<string, unknown>) {
  return {
    _id: doc.personId as string,
    personId: doc.personId as string,
    team: (doc.team as string) ?? null,
    transportation: (doc.transportation as string) ?? null,
    bedroom: (doc.bedroom as string) ?? null,
    checkin: toCheckin(doc.checkin),
    generalNotes: (doc.generalNotes as string) ?? "",
    importId: (doc.importId as string) ?? null,
    importEdited: Array.isArray(doc.importEdited) ? (doc.importEdited as unknown[]).filter((k): k is string => typeof k === "string") : [],
    draft: doc.draft === true,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

/**
 * Camp fields a spreadsheet import may fill (Acampa's §20 app fields). Decision 78: a field a person
 * changed by hand is remembered (its KEY only, in `importEdited`) until an import writes it again, so an
 * import never silently overwrites a manual choice.
 */
export const IMPORT_FIELDS = ["transportation", "bedroom", "team", "roomRole", "bedroomPreference", "invitedBy", "generalNotes"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
const IMPORT_FIELD_SET: ReadonlySet<string> = new Set(IMPORT_FIELDS);

/** Who writes a participant row: a person (manual — remembered per field) or an import batch / conflict decision. */
export type WriteSource = "manual" | "import";

const same = (a: unknown, b: unknown) => (a ?? "") === (b ?? "");

/**
 * The extra update operators for a write of `patch` over `before` (null = an insert):
 * manual → `$addToSet` the import fields whose value really changed; import → `$pull` the ones it wrote.
 */
export function importEditOps(patch: Record<string, unknown>, before: Record<string, unknown> | null, source: WriteSource): Record<string, unknown> {
  const keys = Object.keys(patch).filter((k) => IMPORT_FIELD_SET.has(k) && (source === "import" || (before ? !same(before[k], patch[k]) : !same(patch[k], null))));
  if (keys.length === 0) return {};
  return source === "import" ? { $pull: { importEdited: { $in: keys } } } : { $addToSet: { importEdited: { $each: keys } } };
}

/** The `importEdited` of a new row: the import fields a person filled by hand (an import fills none). */
export function importEditedOnInsert(data: Record<string, unknown>, source: WriteSource): string[] {
  return source === "import" ? [] : Object.keys(data).filter((k) => IMPORT_FIELD_SET.has(k) && !same(data[k], null));
}

/** Every person id of this camp's participants (optionally of one kind). */
export async function listParticipantIds(kind?: ParticipantKind): Promise<string[]> {
  const db = await getDb();
  return (await db.collection(PARTICIPANTS).distinct("personId", kind ? { kind } : {})) as string[];
}

/** Which kind a person is in this camp (null = not a participant). */
export async function participantKind(personId: string): Promise<ParticipantKind | null> {
  const db = await getDb();
  const doc = await db.collection(PARTICIPANTS).findOne({ personId }, { projection: { kind: 1 } });
  return doc ? (doc.kind as ParticipantKind) : null;
}

export async function ensureParticipantIndexes(): Promise<void> {
  const db = await getDb();
  // one row per person per camp (the wrapper prefixes campId)
  await ensureIndex(db.collection(PARTICIPANTS), { personId: 1 }, { unique: true });
  await ensureIndex(db.collection(PARTICIPANTS), { kind: 1, createdAt: 1 });
  await ensureIndex(db.collection(PARTICIPANTS), { bedroom: 1 });
  await ensureIndex(db.collection(PARTICIPANTS), { team: 1 });
  await ensureIndex(db.collection(PARTICIPANTS), { caretakerId: 1 });
  await ensureIndex(db.collection(PARTICIPANTS), { qrToken: 1 }, { sparse: true });
}
