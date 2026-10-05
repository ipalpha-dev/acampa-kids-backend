import { getDb } from "../db";
import type { CamperAiReviewStatus, CamperCheckin, CoreRole } from "../types";

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

export function toAiStatus(v: unknown): CamperAiReviewStatus | null {
  return (["pending", "processing", "structured", "reviewed", "error"] as CamperAiReviewStatus[]).includes(v as CamperAiReviewStatus) ? (v as CamperAiReviewStatus) : null;
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
    draft: doc.draft === true,
    aiReviewStatus: toAiStatus(doc.aiReviewStatus),
    aiReviewError: (doc.aiReviewError as string) ?? "",
    aiReviewStartedAt: (doc.aiReviewStartedAt as Date) ?? null,
    aiReviewFinishedAt: (doc.aiReviewFinishedAt as Date) ?? null,
    aiReviewAttempts: typeof doc.aiReviewAttempts === "number" ? doc.aiReviewAttempts : 0,
    aiReviewNextRetryAt: (doc.aiReviewNextRetryAt as Date) ?? null,
    aiReviewStructured: doc.aiReviewStructured === true,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
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
  await db.collection(PARTICIPANTS).createIndex({ personId: 1 }, { unique: true });
  await db.collection(PARTICIPANTS).createIndex({ kind: 1, createdAt: 1 });
  await db.collection(PARTICIPANTS).createIndex({ bedroom: 1 });
  await db.collection(PARTICIPANTS).createIndex({ team: 1 });
  await db.collection(PARTICIPANTS).createIndex({ caretakerId: 1 });
  await db.collection(PARTICIPANTS).createIndex({ qrToken: 1 }, { sparse: true });
  await db.collection(PARTICIPANTS).createIndex({ aiReviewStatus: 1, createdAt: 1 });
  await db.collection(PARTICIPANTS).createIndex({ importId: 1, aiReviewStatus: 1 });
}
