import { getDb } from "../db";
import type { CamperCheckin, Staff, VestStatus } from "../types";
import { ROOM_ROLES } from "../types";
import { AI_REVIEW_MAX_ATTEMPTS, aiReviewDueFilter, aiReviewRetryAt } from "./aiReviewRetry";
import { baseOf, PARTICIPANTS, toCheckin } from "./participants";

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
export type StaffData = Pick<Staff, "active" | "team" | "transportation" | "bedroom" | "roomRole" | "generalNotes" | "importId"> &
  Partial<Pick<Staff, "draft" | "aiReviewStatus" | "aiReviewError" | "aiReviewStartedAt" | "aiReviewFinishedAt" | "aiReviewAttempts" | "aiReviewNextRetryAt" | "aiReviewStructured">>;

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
export async function insertStaff(personId: string, data: StaffData): Promise<Staff> {
  const db = await getDb();
  const now = new Date();
  const doc = { ...data, ...KIND, personId, checkin: null, vest: NO_VEST, prepDone: [], welcomeSentAt: null, foreignLookupCount: 0, foreignLookupCamperIds: [], foreignLookupAlertedAt: null, createdAt: now, updatedAt: now };
  await db.collection(PARTICIPANTS).insertOne(doc);
  return toStaff(doc)!;
}

export async function updateStaff(personId: string, patch: Partial<StaffData>): Promise<Staff | null> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).findOneAndUpdate({ ...KIND, personId }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

async function claim(filter: Record<string, unknown>, limit: number): Promise<Staff[]> {
  const db = await getDb();
  const out: Staff[] = [];
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const doc = await db.collection(PARTICIPANTS).findOneAndUpdate(
      { ...KIND, ...filter },
      { $set: { aiReviewStatus: "processing", aiReviewStartedAt: now, aiReviewError: "", aiReviewNextRetryAt: null, updatedAt: now } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    const staff = toStaff(doc as Record<string, unknown> | null);
    if (!staff) break;
    out.push(staff);
  }
  return out;
}

/** rows of imports paused for a new sign-in (decision 50) are left alone */
const notPaused = (paused: readonly string[]) => (paused.length ? { importId: { $nin: [...paused] } } : {});

/** Phase 1 claim — the fast structuring pass; skips rows already structured. */
export async function claimStaffForAiReview(limit: number, paused: readonly string[] = []): Promise<Staff[]> {
  return claim({ $or: [{ aiReviewStatus: "pending" }, aiReviewDueFilter(new Date())], aiReviewStructured: { $ne: true }, ...notPaused(paused) }, limit);
}

/** Phase 2 claim — the slow generative cleanup. */
export async function claimStaffForCleanup(limit: number, paused: readonly string[] = []): Promise<Staff[]> {
  return claim({ aiReviewStructured: true, $or: [{ aiReviewStatus: { $in: ["pending", "structured"] } }, aiReviewDueFilter(new Date())], ...notPaused(paused) }, limit);
}

/** Puts a claimed row back (its import paused for a new sign-in): no attempt counted, picked up again on resume. */
export async function releaseStaffReview(personId: string, structured: boolean): Promise<void> {
  const db = await getDb();
  await db.collection(PARTICIPANTS).updateOne({ ...KIND, personId, aiReviewStatus: "processing" }, { $set: { aiReviewStatus: structured ? "structured" : "pending", aiReviewStartedAt: null, updatedAt: new Date() } });
}

async function failStaffReview(personId: string, error: string): Promise<number> {
  const db = await getDb();
  const now = new Date();
  const after = await db.collection(PARTICIPANTS).findOneAndUpdate(
    { ...KIND, personId },
    { $set: { aiReviewStatus: "error", aiReviewError: error, aiReviewFinishedAt: now, updatedAt: now }, $inc: { aiReviewAttempts: 1 } },
    { returnDocument: "after" },
  );
  const attempts = typeof (after as Record<string, unknown> | null)?.aiReviewAttempts === "number" ? ((after as Record<string, unknown>).aiReviewAttempts as number) : 1;
  await db.collection(PARTICIPANTS).updateOne({ ...KIND, personId }, { $set: { aiReviewNextRetryAt: attempts < AI_REVIEW_MAX_ATTEMPTS ? aiReviewRetryAt(attempts, now) : null, updatedAt: new Date() } });
  return attempts;
}

/** Finishes phase 1 (structured). Returns the failed-attempt count on error. */
export async function finishStaffStructure(personId: string, error = ""): Promise<number> {
  if (!error) {
    await updateStaff(personId, { aiReviewStatus: "structured", aiReviewStructured: true, aiReviewError: "", aiReviewNextRetryAt: null });
    return 0;
  }
  return failStaffReview(personId, error);
}

/** Finishes phase 2 (reviewed). Returns the failed-attempt count on error. */
export async function finishStaffAiReview(personId: string, error = ""): Promise<number> {
  if (!error) {
    await updateStaff(personId, { aiReviewStatus: "reviewed", aiReviewError: "", aiReviewFinishedAt: new Date(), aiReviewNextRetryAt: null });
    return 0;
  }
  return failStaffReview(personId, error);
}

export async function requeueStaleStaffAiReviews(staleMs = 15 * 60_000): Promise<number> {
  const db = await getDb();
  const res = await db.collection(PARTICIPANTS).updateMany(
    { ...KIND, aiReviewStatus: "processing", aiReviewStartedAt: { $lt: new Date(Date.now() - staleMs) } },
    { $set: { aiReviewStatus: "pending", aiReviewStartedAt: null, aiReviewError: "", updatedAt: new Date() } },
  );
  return res.modifiedCount;
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
