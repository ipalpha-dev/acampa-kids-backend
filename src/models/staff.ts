import { getDb } from "../db";
import type { CamperCheckin, Staff, VestStatus } from "../types";
import { ROOM_ROLES } from "../types";
import { baseOf, importEditedOnInsert, importEditOps, PARTICIPANTS, toCheckin, type WriteSource } from "./participants";

/**
 * The team of a camp: `participants` rows with `kind: "team"` (camp ops only;
 * `Staff._id` IS the IPAlpha person id). Whether the person may sign in, and
 * as what, is decided by their project roles in projects-api (§10).
 */
const KIND = { kind: "team" } as const;

function toStaff(doc: Record<string, unknown> | null): Staff | null {
  if (!doc) return null;
  return {
    ...baseOf(doc),
    kind: "team",
    active: (doc.active as boolean) ?? true,
    roomRole: ROOM_ROLES.includes(doc.roomRole as Staff["roomRole"]) ? (doc.roomRole as Staff["roomRole"]) : "helper",
    vest: toVest(doc.vest),
    prepDone: (doc.prepDone as string[]) ?? [],
    welcomeSentAt: (doc.welcomeSentAt as Date) ?? null,
    foreignLookupCount: typeof doc.foreignLookupCount === "number" ? doc.foreignLookupCount : 0,
    foreignLookupCamperIds: Array.isArray(doc.foreignLookupCamperIds) ? (doc.foreignLookupCamperIds as string[]) : [],
    foreignLookupAlertedAt: (doc.foreignLookupAlertedAt as Date) ?? null,
  };
}

function toVest(v: unknown): VestStatus {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const delivered = toCheckin(o.delivered);
  return { delivered, returned: delivered ? toCheckin(o.returned) : null };
}

export const NO_VEST: VestStatus = { delivered: null, returned: null };

/** Writable camp-ops fields of a team member. */
export type StaffData = Pick<Staff, "active" | "team" | "transportation" | "bedroom" | "roomRole" | "generalNotes" | "importId"> & Partial<Pick<Staff, "draft">>;

export const EMPTY_STAFF: StaffData = { active: true, team: null, transportation: null, bedroom: null, roomRole: "helper", generalNotes: "", importId: null };

export async function listStaff(filter: { active?: boolean; includeDraft?: boolean; personIds?: string[] } = {}): Promise<Staff[]> {
  const db = await getDb();
  const query: Record<string, unknown> = { ...KIND };
  if (!filter.includeDraft) query.draft = { $ne: true };
  if (filter.active !== undefined) query.active = filter.active;
  if (filter.personIds) query.personId = { $in: filter.personIds };
  const docs = await db.collection(PARTICIPANTS).find(query).sort({ createdAt: 1, personId: 1 }).toArray();
  return docs.map((d) => toStaff(d as Record<string, unknown>)!);
}

export async function findStaffById(personId: string): Promise<Staff | null> {
  if (!personId) return null;
  const db = await getDb();
  return toStaff(await db.collection(PARTICIPANTS).findOne({ ...KIND, personId }));
}

/** Adds a team member (an existing IPAlpha person) to this camp. Throws on a duplicate person (unique index). */
export async function insertStaff(personId: string, data: StaffData, source: WriteSource = "manual"): Promise<Staff> {
  const db = await getDb();
  const now = new Date();
  const doc = { ...data, ...KIND, personId, importEdited: importEditedOnInsert(data, source), checkin: null, vest: NO_VEST, prepDone: [], welcomeSentAt: null, foreignLookupCount: 0, foreignLookupCamperIds: [], foreignLookupAlertedAt: null, createdAt: now, updatedAt: now };
  await db.collection(PARTICIPANTS).insertOne(doc);
  return toStaff(doc)!;
}

/** `source: "import"` = an import batch / an import decision (decision 78: only manual writes are remembered per field). */
export async function updateStaff(personId: string, patch: Partial<StaffData>, source: WriteSource = "manual"): Promise<Staff | null> {
  const db = await getDb();
  const before = source === "manual" ? await db.collection(PARTICIPANTS).findOne({ ...KIND, personId }) : null;
  if (source === "manual" && !before) return null;
  const res = await db.collection(PARTICIPANTS).findOneAndUpdate({ ...KIND, personId }, { $set: { ...patch, updatedAt: new Date() }, ...importEditOps(patch, before, source) }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

/** Marks the person as arrived (`null` undoes it). */
export async function setStaffCheckin(personId: string, checkin: CamperCheckin | null): Promise<Staff | null> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).findOneAndUpdate({ ...KIND, personId }, { $set: { checkin, updatedAt: new Date() } }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

/** Sets the vest (colete) status. */
export async function setStaffVest(personId: string, vest: VestStatus): Promise<Staff | null> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).findOneAndUpdate({ ...KIND, personId }, { $set: { vest, updatedAt: new Date() } }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

/** Clears every vest stamp (rehearsal reset). */
export async function resetStaffVests(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateMany({ ...KIND, "vest.delivered": { $ne: null } }, { $set: { vest: NO_VEST, updatedAt: new Date() } });
  return res.modifiedCount;
}

/** Marks the welcome message as sent — atomically, only once. True when this call won. */
export async function claimStaffWelcome(personId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateOne({ ...KIND, personId, welcomeSentAt: null }, { $set: { welcomeSentAt: new Date() } });
  return res.modifiedCount === 1;
}

/** Marks the "photos in the app" message as sent to this person — once per camp. */
export async function claimStaffPhotosNotice(personId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db
    .collection(PARTICIPANTS)
    .updateOne({ ...KIND, personId, $or: [{ photosSmsSentAt: null }, { photosSmsSentAt: { $exists: false } }] }, { $set: { photosSmsSentAt: new Date() } });
  return res.modifiedCount === 1;
}

export async function resetStaffPhotosNotice(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateMany({ ...KIND, photosSmsSentAt: { $ne: null } }, { $set: { photosSmsSentAt: null } });
  return res.modifiedCount;
}

/** Clears every team member's check-in (rehearsal reset). */
export async function resetStaffCheckins(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateMany({ ...KIND, checkin: { $ne: null } }, { $set: { checkin: null, updatedAt: new Date() } });
  return res.modifiedCount;
}

/** Thresholds for out-of-scope emergency QR lookups (see routes/campers.ts lookup). */
export const FOREIGN_LOOKUP_ALERT_AT = 3;
export const FOREIGN_LOOKUP_BLOCK_AT = 5;

/** Records one more DISTINCT out-of-scope kid for this team member (no-op for a kid already counted). */
export async function recordForeignLookup(personId: string, camperId: string): Promise<Staff | null> {
  const current = await findStaffById(personId);
  if (!current) return null;
  if (current.foreignLookupCamperIds.includes(camperId)) return current;
  const db = await getDb();
  const res = await db
    .collection(PARTICIPANTS)
    .findOneAndUpdate({ ...KIND, personId }, { $inc: { foreignLookupCount: 1 }, $addToSet: { foreignLookupCamperIds: camperId }, $set: { updatedAt: new Date() } }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

/** The coordenação was already told about this person's out-of-scope scans (once until reset). */
export async function markForeignLookupAlerted(personId: string): Promise<void> {
  const db = await getDb();
  await db.collection(PARTICIPANTS).updateOne({ ...KIND, personId, foreignLookupAlertedAt: null }, { $set: { foreignLookupAlertedAt: new Date(), updatedAt: new Date() } });
}

/** Zeroes every out-of-scope lookup counter. */
export async function resetForeignLookups(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateMany(
    { ...KIND, $or: [{ foreignLookupCount: { $gt: 0 } }, { foreignLookupCamperIds: { $exists: true, $ne: [] } }] },
    { $set: { foreignLookupCount: 0, foreignLookupCamperIds: [], foreignLookupAlertedAt: null, updatedAt: new Date() } },
  );
  return res.modifiedCount;
}

/** Team members at / past the alert threshold. */
export async function listForeignLookupOffenders(minCount = FOREIGN_LOOKUP_ALERT_AT): Promise<Staff[]> {
  const db = await getDb();
  const docs = await db.collection(PARTICIPANTS).find({ ...KIND, foreignLookupCount: { $gte: minCount } }).sort({ foreignLookupCount: -1 }).toArray();
  return docs.map((d) => toStaff(d as Record<string, unknown>)!);
}

/** Ticks / unticks one Preparação item for the person. */
export async function setStaffPrepDone(personId: string, key: string, done: boolean): Promise<Staff | null> {
  const db = await getDb();
  const res = await db
    .collection(PARTICIPANTS)
    .findOneAndUpdate(
      { ...KIND, personId },
      (done ? { $addToSet: { prepDone: key }, $set: { updatedAt: new Date() } } : { $pull: { prepDone: key }, $set: { updatedAt: new Date() } }) as never,
      { returnDocument: "after" },
    );
  return toStaff(res as Record<string, unknown> | null);
}

export async function deleteStaff(personId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).deleteOne({ ...KIND, personId });
  return res.deletedCount === 1;
}

/** participants indexes live in models/participants.ts */
export async function ensureStaffIndexes(): Promise<void> {}
