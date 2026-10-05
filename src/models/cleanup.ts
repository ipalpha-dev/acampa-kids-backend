import { getDb } from "../db";
import { currentCampId } from "../services/campContext";
import { countUserNotificationMarks, resetUserPhotosNotice, resetUserWelcome } from "./userCampState";

/**
 * End-of-camp cleanup (Configurações → Limpeza, admin only): each group wipes
 * its own documents AND every reference the rest of the data keeps to them,
 * so the database is left ready for next year's camp.
 *
 * What is NEVER touched here: the people themselves (they live in IPAlpha
 * persons-api / projects-api — only Acampa's camp-ops rows go) and the categories.
 * The funções (schedule roles) with their instructions / preparation texts and
 * the Preparação / Instruções content are reused every year, so they only go
 * when asked for explicitly: the "docs" block, and the Programação toggle.
 */
export const CLEANUP_GROUPS = ["campers", "staff", "bedrooms", "transports", "teams", "schedule", "docs", "occurrences", "medications", "scores", "gallery", "welcomes", "notices"] as const;
export type CleanupGroup = (typeof CLEANUP_GROUPS)[number];

/**
 * Every kid, plus the check-in log, the parents' edit log, the emergency-QR
 * lookups (and the counters they feed), the per-kid point scans and the
 * medical team's medication checklist (each tick belongs to a kid).
 */
export async function wipeCampers(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("participants").deleteMany({ kind: "camper" });
  await Promise.all([
    db.collection("checkinLog").deleteMany({}),
    db.collection("medicationDoses").deleteMany({}),
    db.collection("camperChangeLog").deleteMany({}),
    db.collection("camperLookups").deleteMany({}),
    db.collection("scores").deleteMany({ camperId: { $ne: null } }),
    db.collection("participants").updateMany(
      { kind: "team", $or: [{ foreignLookupCount: { $gt: 0 } }, { foreignLookupCamperIds: { $exists: true, $ne: [] } }] },
      { $set: { foreignLookupCount: 0, foreignLookupCamperIds: [], foreignLookupAlertedAt: null, updatedAt: new Date() } },
    ),
  ]);
  return deletedCount;
}

/**
 * Settings lists that point at team members. When the Equipe block is wiped,
 * each may be KEPT (Configurações → Limpeza): its people survive the wipe and
 * the list stays. (Helper ROLES live in projects-api and are never touched.)
 */
export const STAFF_KEEP_GROUPS = ["busHelpers", "parentContacts"] as const;
export type StaffKeepGroup = (typeof STAFF_KEEP_GROUPS)[number];

function personIdsOf(settings: Record<string, unknown> | null, group: StaffKeepGroup): string[] {
  if (!settings) return [];
  if (group === "busHelpers") return ((settings.busHelpers as { helpers?: { personId: string }[] } | undefined)?.helpers ?? []).map((h) => h.personId);
  return ((settings.parentContacts as { personId: string }[] | undefined) ?? []).map((p) => p.personId);
}

function emptyList(group: StaffKeepGroup): unknown {
  return group === "busHelpers" ? { helpers: [] } : [];
}

/**
 * Every team row except the people on the lists named in `keep`, plus their
 * event assignments, the kids they looked after and every list that named
 * them. Memberships in projects-api are not touched (Mordomia owns them).
 */
export async function wipeStaff(keep: readonly StaffKeepGroup[] = []): Promise<number> {
  const db = await getDb();
  const settings = (await db.collection("settings").findOne({ _id: currentCampId() as never })) as Record<string, unknown> | null;
  const saved = [...new Set(keep.flatMap((g) => personIdsOf(settings, g)))];
  const filter = { kind: "team", personId: { $nin: saved } };
  const doomed = (await db.collection("participants").find(filter, { projection: { personId: 1 } }).toArray()).map((d) => String(d.personId));
  const { deletedCount } = await db.collection("participants").deleteMany(filter);
  const now = new Date();
  const lists: Record<string, unknown> = { updatedAt: now };
  for (const g of STAFF_KEEP_GROUPS) if (!keep.includes(g)) lists[g] = emptyList(g);
  await Promise.all([
    db.collection("participants").updateMany({ kind: "camper", caretakerId: { $in: doomed } }, { $set: { caretakerId: null, updatedAt: now } }),
    db.collection<Record<string, unknown>>("schedule_events").updateMany(
      { "assignments.staffId": { $in: doomed } },
      { $pull: { assignments: { staffId: { $in: doomed } } } as never, $set: { updatedAt: now } },
    ),
    db.collection("settings").updateOne({ _id: currentCampId() as never }, { $set: lists }),
  ]);
  return deletedCount;
}

/** Every room; the kids and the team lose their room, bed and caretaker (a caretaker is a room link). */
export async function wipeBedrooms(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("bedrooms").deleteMany({});
  const now = new Date();
  await Promise.all([
    db.collection("participants").updateMany({ kind: "camper", $or: [{ bedroom: { $ne: null } }, { bed: { $ne: null } }, { caretakerId: { $ne: null } }] }, { $set: { bedroom: null, bed: null, caretakerId: null, updatedAt: now } }),
    db.collection("participants").updateMany({ kind: "team", bedroom: { $ne: null } }, { $set: { bedroom: null, updatedAt: now } }),
  ]);
  return deletedCount;
}

/** Every bus / car; the kids and the team lose their vehicle and the door helpers are cleared. */
export async function wipeTransports(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("transports").deleteMany({});
  const now = new Date();
  await Promise.all([
    db.collection("participants").updateMany({ transportation: { $ne: null } }, { $set: { transportation: null, updatedAt: now } }),
    db.collection("settings").updateOne({ _id: currentCampId() as never }, { $set: { busHelpers: { helpers: [] }, updatedAt: now } }),
  ]);
  return deletedCount;
}

/** Every team, the kids' and the team's badge, and the whole scoreboard ledger (each line belongs to a team). */
export async function wipeTeams(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("teams").deleteMany({});
  const now = new Date();
  await Promise.all([
    db.collection("participants").updateMany({ team: { $ne: null } }, { $set: { team: null, updatedAt: now } }),
    db.collection("scores").deleteMany({}),
  ]);
  return deletedCount;
}

/**
 * Every event of the programme; the photos of an event become general.
 * The funções are kept by default (their texts are reused every year) — with
 * `withRoles` they go too, along with their instructions and preparation.
 */
export async function wipeSchedule(withRoles = false): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("schedule_events").deleteMany({});
  const now = new Date();
  const [roles] = await Promise.all([
    withRoles ? db.collection("schedule_roles").deleteMany({}) : Promise.resolve({ deletedCount: 0 }),
    db.collection("gallery").updateMany({ eventId: { $ne: null } }, { $set: { eventId: null, updatedAt: now } }),
    db.collection("scores").updateMany({ eventId: { $ne: null } }, { $set: { eventId: null } }),
  ]);
  return deletedCount + roles.deletedCount;
}

/**
 * The texts the team reads: Instruções and Preparação (one block — they are
 * written together and reused together). The Preparação checklist ticks point
 * at the deleted sections, so they go with them (team and parents alike).
 */
export async function wipeDocs(): Promise<number> {
  const db = await getDb();
  const now = new Date();
  const campId = currentCampId();
  const [instructions, prep] = await Promise.all([
    db.collection("instructions").deleteMany({}),
    db.collection("prep_sections").deleteMany({}),
    db.collection("participants").updateMany({ kind: "team", prepDone: { $exists: true, $ne: [] } }, { $set: { prepDone: [], updatedAt: now } }),
    db.collection("userCampState").updateMany({ campId, prepDone: { $exists: true, $ne: [] } }, { $set: { prepDone: [] } }),
  ]);
  return instructions.deletedCount + prep.deletedCount;
}

export async function wipeOccurrences(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("occurrences").deleteMany({});
  return deletedCount;
}

/** Every dose the medical team ticked (the prescriptions stay on the kids). */
export async function wipeMedications(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("medicationDoses").deleteMany({});
  return deletedCount;
}

export async function wipeScores(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("scores").deleteMany({});
  return deletedCount;
}

/**
 * Puts the camp's dates and rehearsal switches back to zero — part of
 * "limpar tudo", so next year never starts with this year's windows open.
 */
export async function resetCampSettings(): Promise<void> {
  const db = await getDb();
  await db.collection("settings").updateOne(
    { _id: currentCampId() as never },
    {
      $set: {
        checkinWindow: { from: null, until: null },
        busReturnWindow: { from: null, until: null },
        staffAccessWindow: { from: null, until: null },
        parentAccessWindow: { from: null, until: null },
        checkinReminder: { at: null, sentAt: null },
        checkinTestMode: false,
        kidsRoomsDraft: false,
        scoreDraft: false,
        scoreHideWindow: { from: null, until: null },
        updatedAt: new Date(),
      },
    },
  );
}

/** Every photo of the album. Returns the ids of the full-size files the caller must drop too. */
export async function wipeGallery(): Promise<{ count: number; fileIds: string[] }> {
  const db = await getDb();
  const docs = (await db.collection("gallery").find({}, { projection: { fileId: 1 } }).toArray()) as Record<string, unknown>[];
  const { deletedCount } = await db.collection("gallery").deleteMany({});
  return { count: deletedCount, fileIds: docs.map((d) => d.fileId as string).filter(Boolean) };
}

/**
 * The "already sent" memory of the welcome SMS that goes out ONCE when each
 * access window opens (`welcomeSentAt` on the team and on the parents).
 * Clearing it re-arms the welcome: whoever has a phone is greeted again the
 * next time their window is open and the toggle is on.
 */
export async function wipeWelcomes(): Promise<number> {
  const db = await getDb();
  const now = new Date();
  const [team, parents] = await Promise.all([
    db.collection("participants").updateMany({ kind: "team", welcomeSentAt: { $ne: null } }, { $set: { welcomeSentAt: null, updatedAt: now } }),
    resetUserWelcome(),
  ]);
  return team.modifiedCount + parents;
}

/**
 * The "already sent" memory of every notice that is delivered only once per
 * camp — the check-in reminder (its hour), the album notice (the photos went
 * up) and the birthday of each kid. Clearing it arms all of them again.
 */
export async function wipeNotices(): Promise<number> {
  const db = await getDb();
  const now = new Date();
  const [team, parents, kids, reminder] = await Promise.all([
    db.collection("participants").updateMany({ kind: "team", photosSmsSentAt: { $ne: null } }, { $set: { photosSmsSentAt: null, updatedAt: now } }),
    resetUserPhotosNotice(),
    db.collection("participants").updateMany({ kind: "camper", birthdayNoticeDay: { $ne: null } }, { $unset: { birthdayNoticeDay: "" }, $set: { updatedAt: now } }),
    db.collection("settings").updateOne({ _id: currentCampId() as never, "checkinReminder.sentAt": { $ne: null } }, { $set: { "checkinReminder.sentAt": null, updatedAt: now } }),
  ]);
  return team.modifiedCount + parents + kids.modifiedCount + reminder.modifiedCount;
}

/**
 * The import DICTIONARY cache (`camperImportDictionary`): the remembered
 * spreadsheet-value → app-value mappings that both the staff and the camper
 * imports reuse to skip re-mapping the same columns every year. SUPER ADMIN
 * only — clearing it makes the next import start its mapping from scratch.
 */
export async function wipeImportCache(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("camperImportDictionary").deleteMany({});
  return deletedCount;
}

/** Staff-import column mappings only (`staff-column:…`). */
export async function wipeStaffImportCache(): Promise<number> {
  const db = await getDb();
  const { deletedCount } = await db.collection("camperImportDictionary").deleteMany({ field: { $regex: "^staff-column:" } });
  return deletedCount;
}

/** How many remembered mappings the import dictionary cache holds. */
export async function countImportCache(): Promise<{ count: number; staff: number; campers: number }> {
  const db = await getDb();
  const col = db.collection("camperImportDictionary");
  const [count, staff] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments({ field: { $regex: "^staff-column:" } }),
  ]);
  return { count, staff, campers: Math.max(0, count - staff) };
}

/**
 * How many "already sent" marks each of the two notification blocks holds.
 * These live on the people (and on the settings), not in the realtime
 * collections, so the page asks for them.
 */
export async function countNotificationMarks(): Promise<{ welcomes: number; notices: number }> {
  const db = await getDb();
  const sent = { $ne: null };
  const [staffWelcome, staffPhotos, birthdays, reminder, userMarks] = await Promise.all([
    db.collection("participants").countDocuments({ kind: "team", welcomeSentAt: sent }),
    db.collection("participants").countDocuments({ kind: "team", photosSmsSentAt: sent }),
    db.collection("participants").countDocuments({ kind: "camper", birthdayNoticeDay: sent }),
    db.collection("settings").countDocuments({ _id: currentCampId() as never, "checkinReminder.sentAt": sent }),
    countUserNotificationMarks(),
  ]);
  return { welcomes: staffWelcome + userMarks.welcomes, notices: staffPhotos + userMarks.photos + birthdays + reminder };
}
