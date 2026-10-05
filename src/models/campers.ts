import { getDb } from "../db";
import type { Camper, CamperChangeLog, CamperCheckin, CheckinKind, CheckinLog } from "../types";
import { baseOf, PARTICIPANTS, toCheckin } from "./participants";

export { toCheckin } from "./participants";

/**
 * The kids of a camp: `participants` rows with `kind: "camper"` (camp ops
 * only). `Camper._id` IS the IPAlpha person id. Name / health / guardian are
 * read from core at use (services/people.ts).
 */
const LOG_COLLECTION = "checkinLog";
/** which fields of a kid changed and who did it (no values — those live in persons-api) */
const CHANGE_LOG_COLLECTION = "camperChangeLog";
const KIND = { kind: "camper" } as const;

function toCamper(doc: Record<string, unknown> | null): Camper | null {
  if (!doc) return null;
  return {
    ...baseOf(doc),
    kind: "camper",
    invitedBy: (doc.invitedBy as string) ?? "",
    caretakerId: (doc.caretakerId as string) ?? null,
    qrToken: (doc.qrToken as string) ?? "",
    bed: (doc.bed as string) ?? null,
    bedroomPreference: (doc.bedroomPreference as string) ?? "",
    busCheckin: toCheckin(doc.busCheckin),
    busReturnCheckin: toCheckin(doc.busReturnCheckin),
    parentEditedAt: (doc.parentEditedAt as Date) ?? null,
  };
}

/** Writable camp-ops fields of a kid. */
export type CamperData = Pick<Camper, "team" | "transportation" | "bedroom" | "bed" | "caretakerId" | "qrToken" | "invitedBy" | "generalNotes" | "bedroomPreference" | "importId"> & Partial<Pick<Camper, "draft">>;

export const EMPTY_CAMPER: CamperData = { team: null, transportation: null, bedroom: null, bed: null, caretakerId: null, qrToken: "", invitedBy: "", generalNotes: "", bedroomPreference: "", importId: null };

/** which document field holds each kind of check-in */
export const CHECKIN_FIELD: Record<CheckinKind, "checkin" | "busCheckin" | "busReturnCheckin"> = {
  church: "checkin",
  bus: "busCheckin",
  bus_return: "busReturnCheckin",
};

export async function listCampers(filter: { bedroom?: string; caretakerId?: string; personIds?: string[]; includeDraft?: boolean } = {}): Promise<Camper[]> {
  const db = await getDb();
  const query: Record<string, unknown> = { ...KIND };
  if (!filter.includeDraft) query.draft = { $ne: true };
  if (filter.bedroom) query.bedroom = filter.bedroom;
  if (filter.caretakerId) query.caretakerId = filter.caretakerId;
  if (filter.personIds) query.personId = { $in: filter.personIds };
  const docs = await db.collection(PARTICIPANTS).find(query).sort({ createdAt: 1, personId: 1 }).toArray();
  return docs.map((d) => toCamper(d as Record<string, unknown>)!);
}

export async function findCamperById(personId: string): Promise<Camper | null> {
  if (!personId) return null;
  const db = await getDb();
  return toCamper(await db.collection(PARTICIPANTS).findOne({ ...KIND, personId }));
}

export async function findCamperByQrToken(qrToken: string): Promise<Camper | null> {
  if (!qrToken) return null;
  const db = await getDb();
  return toCamper(await db.collection(PARTICIPANTS).findOne({ ...KIND, qrToken }));
}

/** Adds a kid (an existing IPAlpha person) to this camp. Throws on a duplicate person (unique index). */
export async function insertCamper(personId: string, data: CamperData): Promise<Camper> {
  const db = await getDb();
  const now = new Date();
  const doc = { ...data, ...KIND, personId, checkin: null, busCheckin: null, busReturnCheckin: null, parentEditedAt: null, createdAt: now, updatedAt: now };
  await db.collection(PARTICIPANTS).insertOne(doc);
  return toCamper(doc)!;
}

export async function updateCamper(personId: string, patch: Partial<CamperData>): Promise<Camper | null> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).findOneAndUpdate({ ...KIND, personId }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toCamper(res as Record<string, unknown> | null);
}

/** Every kid of caretaker `from` goes to caretaker `to` (null = orphans). Returns how many moved. */
export async function reassignCampers(from: string, to: string | null, extra: Partial<CamperData> = {}): Promise<number> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateMany({ ...KIND, caretakerId: from }, { $set: { ...extra, caretakerId: to, updatedAt: new Date() } });
  return res.modifiedCount;
}

/** The given kids (person ids) get caretaker `to` (null = orphans). */
export async function setCaretakerOf(ids: string[], to: string | null): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  await db.collection(PARTICIPANTS).updateMany({ ...KIND, personId: { $in: ids } }, { $set: { caretakerId: to, updatedAt: new Date() } });
}

/** Marks the kid as arrived (church) or boarded (bus); `null` undoes it. */
export async function setCamperCheckin(personId: string, kind: CheckinKind, checkin: CamperCheckin | null): Promise<Camper | null> {
  const db = await getDb();
  const res = await db
    .collection(PARTICIPANTS)
    .findOneAndUpdate({ ...KIND, personId }, { $set: { [CHECKIN_FIELD[kind]]: checkin, updatedAt: new Date() } }, { returnDocument: "after" });
  return toCamper(res as Record<string, unknown> | null);
}

/** Clears church + both bus check-ins of every kid (rehearsal reset). Returns how many had one. */
export async function resetCamperCheckins(): Promise<number> {
  const db = await getDb();
  const res = await db
    .collection(PARTICIPANTS)
    .updateMany(
      { ...KIND, $or: [{ checkin: { $ne: null } }, { busCheckin: { $ne: null } }, { busReturnCheckin: { $ne: null } }] },
      { $set: { checkin: null, busCheckin: null, busReturnCheckin: null, updatedAt: new Date() } },
    );
  return res.modifiedCount;
}

/** Wipes the audit trail (rehearsal reset). */
export async function clearCheckinLog(): Promise<void> {
  const db = await getDb();
  await db.collection(LOG_COLLECTION).deleteMany({});
}

/** Append-only audit line: who did (or undid) a check-in and when (person ids only). */
export async function logCheckin(entry: Omit<CheckinLog, "_id">): Promise<void> {
  const db = await getDb();
  await db.collection(LOG_COLLECTION).insertOne({ ...entry });
}

/** Audit trail, newest first (optionally for one person). */
export async function listCheckinLog(personId?: string): Promise<CheckinLog[]> {
  const db = await getDb();
  const docs = await db.collection(LOG_COLLECTION).find(personId ? { personId } : {}).sort({ at: -1 }).toArray();
  return docs.map((d) => ({ ...(d as unknown as CheckinLog), _id: String(d._id) }));
}

/**
 * Append-only: one line per edit to a kid (parent or medical team) with the
 * FIELDS that changed. Parent edits also stamp `parentEditedAt`.
 */
export async function logCamperChange(entry: Omit<CamperChangeLog, "_id">, stampParentEditedAt = true): Promise<void> {
  const db = await getDb();
  await db.collection(CHANGE_LOG_COLLECTION).insertOne({ ...entry });
  if (stampParentEditedAt) await db.collection(PARTICIPANTS).updateOne({ ...KIND, personId: entry.personId }, { $set: { parentEditedAt: entry.at } });
}

/** The edit history of one kid, newest first. */
export async function listCamperChanges(personId: string): Promise<CamperChangeLog[]> {
  const db = await getDb();
  const docs = await db.collection(CHANGE_LOG_COLLECTION).find({ personId }).sort({ at: -1 }).toArray();
  return docs.map((d) => ({ ...(d as unknown as CamperChangeLog), _id: String(d._id) }));
}

export async function deleteCamper(personId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).deleteOne({ ...KIND, personId });
  return res.deletedCount === 1;
}

/** How many campers are in each bedroom. */
export async function countCampersPerBedroom(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .collection(PARTICIPANTS)
    .aggregate<{ _id: string; n: number }>([{ $match: { ...KIND, draft: { $ne: true }, bedroom: { $type: "string" } } }, { $group: { _id: "$bedroom", n: { $sum: 1 } } }])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

/**
 * Marks the birthday message for `day` as sent — atomically, only if it was
 * NOT sent for that day yet. True when this call won.
 */
export async function claimBirthdayNotice(personId: string, day: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateOne({ ...KIND, personId, birthdayNoticeDay: { $ne: day } }, { $set: { birthdayNoticeDay: day } });
  return res.modifiedCount === 1;
}

/** A birthday message that could not go out: the marker is lifted so the next run tries again. */
export async function releaseBirthdayNotice(personId: string, day: string): Promise<void> {
  const db = await getDb();
  await db.collection(PARTICIPANTS).updateOne({ ...KIND, personId, birthdayNoticeDay: day }, { $unset: { birthdayNoticeDay: "" } });
}

/**
 * Lifts every marker of another day: a marker only lives on its own day, so
 * Acampa never keeps a trace of when a kid's birthday is (no birth date at rest).
 */
export async function clearStaleBirthdayNotices(today: string): Promise<number> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateMany({ ...KIND, birthdayNoticeDay: { $exists: true, $nin: [today, null] } }, { $unset: { birthdayNoticeDay: "" } });
  return res.modifiedCount;
}

export async function ensureCamperIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(LOG_COLLECTION).createIndex({ personId: 1, at: -1 });
  await db.collection(LOG_COLLECTION).createIndex({ at: -1 });
  await db.collection(CHANGE_LOG_COLLECTION).createIndex({ personId: 1, at: -1 });
}
