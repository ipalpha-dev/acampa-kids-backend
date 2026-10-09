import { getDb } from "../db";
import { currentCampId } from "../services/campContext";
import { ensureIndex } from "../services/indexes";

const COLLECTION = "userCampState";

/**
 * Per-year marks of a person who is NOT a participant row (parents —
 * CONTRACTS §15 "userCampState keyed by personId"): `prepDone`,
 * `welcomeSentAt`, `photosSmsSentAt`. One row per (person, camp). UNSCOPED collection (it
 * carries its own `campId` field instead of relying on the `Db` wrapper),
 * because it is looked up by an explicit camp id as often as by the current one.
 */
export interface UserCampState {
  personId: string;
  campId: string;
  prepDone: string[];
  welcomeSentAt: Date | null;
  photosSmsSentAt: Date | null;
}

function toState(doc: Record<string, unknown> | null): UserCampState | null {
  if (!doc) return null;
  return {
    personId: doc.personId as string,
    campId: doc.campId as string,
    prepDone: (doc.prepDone as string[]) ?? [],
    welcomeSentAt: (doc.welcomeSentAt as Date) ?? null,
    photosSmsSentAt: (doc.photosSmsSentAt as Date) ?? null,
  };
}

const EMPTY: Omit<UserCampState, "personId" | "campId"> = { prepDone: [], welcomeSentAt: null, photosSmsSentAt: null };

export async function findUserCampState(personId: string, campId: string = currentCampId()): Promise<UserCampState | null> {
  const db = await getDb();
  return toState(await db.collection(COLLECTION).findOne({ personId, campId }));
}

/** Every state row for the given camp, keyed by personId — used to merge onto a list of users in one query. */
export async function listUserCampStates(personIds: string[], campId: string = currentCampId()): Promise<Map<string, UserCampState>> {
  if (personIds.length === 0) return new Map();
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find({ personId: { $in: personIds }, campId }).toArray();
  return new Map(docs.map((d) => [d.personId as string, toState(d as Record<string, unknown>)!]));
}

/** The fields a user's profile carries for the current camp, defaulting to empty when no row exists yet. */
export function stateOrEmpty(state: UserCampState | null | undefined): Omit<UserCampState, "personId" | "campId"> {
  return state ? { prepDone: state.prepDone, welcomeSentAt: state.welcomeSentAt, photosSmsSentAt: state.photosSmsSentAt } : EMPTY;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

async function claimMark(personId: string, campId: string, field: "welcomeSentAt" | "photosSmsSentAt"): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const res = await db.collection(COLLECTION).updateOne({ personId, campId, $or: [{ [field]: null }, { [field]: { $exists: false } }] }, { $set: { [field]: now } });
  if (res.modifiedCount === 1) return true;
  if (res.matchedCount === 1) return false;
  try {
    await db.collection(COLLECTION).insertOne({ personId, campId, ...EMPTY, [field]: now });
    return true;
  } catch (err) {
    if (isDuplicateKey(err)) return false;
    throw err;
  }
}

export async function claimUserWelcome(personId: string, campId: string = currentCampId()): Promise<boolean> {
  return claimMark(personId, campId, "welcomeSentAt");
}

export async function resetUserWelcome(campId: string = currentCampId()): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ campId, welcomeSentAt: { $ne: null } }, { $set: { welcomeSentAt: null } });
  return res.modifiedCount;
}

/** Lifts one person's (or one audience mark's) welcome — a send that failed is tried again. */
export async function resetUserWelcomeOf(personId: string, campId: string = currentCampId()): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).updateOne({ personId, campId }, { $set: { welcomeSentAt: null } });
}

export async function claimUserPhotosNotice(personId: string, campId: string = currentCampId()): Promise<boolean> {
  return claimMark(personId, campId, "photosSmsSentAt");
}

export async function resetUserPhotosNotice(campId: string = currentCampId()): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ campId, photosSmsSentAt: { $ne: null } }, { $set: { photosSmsSentAt: null } });
  return res.modifiedCount;
}

export async function resetUserPhotosNoticeOf(personId: string, campId: string = currentCampId()): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).updateOne({ personId, campId }, { $set: { photosSmsSentAt: null } });
}

/**
 * A responsável proposed by a link request who is NOT yet a family of the edition (decision 80): remembered (id + a
 * date, nothing else) so their acceptance welcomes them like any family that joins late.
 */
export async function markJoinWelcome(personId: string, campId: string = currentCampId()): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).updateOne({ personId, campId }, { $set: { joinWelcomeAt: new Date() }, $setOnInsert: { ...EMPTY } }, { upsert: true });
}

/** Takes the mark (atomically): true once, when this person was marked. */
export async function takeJoinWelcome(personId: string, campId: string = currentCampId()): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateOne({ personId, campId, joinWelcomeAt: { $exists: true } }, { $unset: { joinWelcomeAt: "" } });
  return res.modifiedCount === 1;
}

export async function setUserPrepDoneState(personId: string, key: string, done: boolean, campId: string = currentCampId()): Promise<UserCampState> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).findOneAndUpdate(
    { personId, campId },
    (done
      ? { $addToSet: { prepDone: key }, $setOnInsert: { welcomeSentAt: null, photosSmsSentAt: null } }
      : { $pull: { prepDone: key }, $setOnInsert: { welcomeSentAt: null, photosSmsSentAt: null } }) as never,
    { upsert: true, returnDocument: "after" },
  );
  return toState(res as Record<string, unknown>)!;
}

/** Drops one checklist key ("section:<id>") from every parent's state in the current camp — after a Preparação section is deleted. */
export async function clearUserPrepDoneKey(key: string, campId: string = currentCampId()): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).updateMany({ campId, prepDone: key }, { $pull: { prepDone: key } } as never);
}

/** Every "already sent" mark on the current camp's users — for the Limpeza counters. */
export async function countUserNotificationMarks(campId: string = currentCampId()): Promise<{ welcomes: number; photos: number }> {
  const db = await getDb();
  const [welcomes, photos] = await Promise.all([
    db.collection(COLLECTION).countDocuments({ campId, welcomeSentAt: { $ne: null } }),
    db.collection(COLLECTION).countDocuments({ campId, photosSmsSentAt: { $ne: null } }),
  ]);
  return { welcomes, photos };
}

/** SUPER ADMIN handover / camp deletion: drop this camp's rows for the given users (or every row of the camp). */
export async function deleteUserCampStates(campId: string, personIds?: string[]): Promise<number> {
  const db = await getDb();
  const filter: Record<string, unknown> = { campId };
  if (personIds) filter.personId = { $in: personIds };
  const res = await db.collection(COLLECTION).deleteMany(filter);
  return res.deletedCount;
}

export async function ensureUserCampStateIndexes(): Promise<void> {
  const db = await getDb();
  // decision 91: the key moved from `userId` to `personId` → a new name, and partial so a row without
  // `personId` (an older version's `userId` row) never makes the unique index fail
  await ensureIndex(db.collection(COLLECTION), { personId: 1, campId: 1 }, { name: "personId_campId_unique_v2", unique: true, partialFilterExpression: { personId: { $exists: true } } });
}
