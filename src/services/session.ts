import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config";
import { getDb } from "../db";
import { activeCampId } from "./campContext";
import { forgetSessionValidation } from "./sessionValidation";
import { closePersonSockets, closeSessionSockets } from "./realtime";
import type { RoleGrant } from "./ipalpha/coreClient";
import type { CoreRole, Session } from "../types";
import { ensureIndex } from "./indexes";

/**
 * Acampa sessions (CONTRACTS §15): `{personId, roles[], activeRole, campId,
 * roleTokens, offlineKey, expiresAt (sliding), hours}`.
 *
 *   - The browser holds only an opaque random token; the collection keys the
 *     session by its sha256, so a database dump never yields a usable token.
 *   - The per-role IPAlpha tokens are sealed with AES-256-GCM
 *     (`SESSION_TOKEN_KEY`) and opened only to call core for this person —
 *     never logged, never sent to the browser.
 *   - The offline key (decision 35) is random per session and per role switch.
 *   - The idle length (`hours`) is auth-api's `sessionIdleHours`, fixed at
 *     login; every authenticated request slides `expiresAt` (at most once a
 *     minute, to spare writes).
 */

const COLLECTION = "sessions";
const SLIDE_EVERY_MS = 60_000;

export class SessionKeyMissing extends Error {}

function key(): Buffer {
  const raw = config.ipalpha.sessionTokenKey;
  if (!raw) throw new SessionKeyMissing("SESSION_TOKEN_KEY is not set");
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new SessionKeyMissing("SESSION_TOKEN_KEY must be 32 bytes (64 hex chars or base64)");
  return buf;
}

/** AES-256-GCM: base64url(iv[12] | tag[16] | ciphertext). */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export function unseal(sealed: string): string {
  const buf = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type RoleTokens = Record<string, Omit<RoleGrant, "role">>;

function sealGrants(grants: RoleGrant[]): string {
  const map: RoleTokens = {};
  for (const g of grants) map[g.role] = { tokens: g.tokens, expiresAt: g.expiresAt, editionId: g.editionId };
  return seal(JSON.stringify(map));
}

export function openRoleTokens(session: Pick<Session, "roleTokens">): RoleTokens {
  try {
    return JSON.parse(unseal(session.roleTokens)) as RoleTokens;
  } catch {
    return {};
  }
}

/** a fresh 32-byte key for the offline copy, sealed for storage */
function newOfflineKey(): string {
  return seal(randomBytes(32).toString("base64"));
}

export function openOfflineKey(session: Pick<Session, "offlineKey">): string {
  return unseal(session.offlineKey);
}

function toSession(doc: Record<string, unknown> | null): Session | null {
  if (!doc) return null;
  return {
    _id: doc._id as string,
    personId: doc.personId as string,
    roles: (doc.roles as CoreRole[]) ?? [],
    activeRole: doc.activeRole as CoreRole,
    campId: (doc.campId as string) ?? activeCampId(),
    roleTokens: (doc.roleTokens as string) ?? "",
    offlineKey: (doc.offlineKey as string) ?? "",
    createdAt: doc.createdAt as Date,
    expiresAt: doc.expiresAt as Date,
    hours: typeof doc.hours === "number" ? doc.hours : config.sessionHours,
  };
}

/**
 * Opens a session for `personId` holding `grants` (one per live project role).
 * Returns the opaque token for the browser — shown once, stored only hashed.
 */
export async function createSession(input: { personId: string; grants: RoleGrant[]; activeRole: CoreRole; campId?: string; hours?: number | null }): Promise<{ token: string; session: Session }> {
  const db = await getDb();
  const now = new Date();
  const hours = input.hours && Number.isFinite(input.hours) && input.hours > 0 ? input.hours : config.sessionHours;
  const token = randomBytes(32).toString("base64url");
  const session: Session = {
    _id: hashToken(token),
    personId: input.personId,
    roles: input.grants.map((g) => g.role),
    activeRole: input.activeRole,
    campId: input.campId ?? activeCampId(),
    roleTokens: sealGrants(input.grants),
    offlineKey: newOfflineKey(),
    createdAt: now,
    expiresAt: new Date(now.getTime() + hours * 3600_000),
    hours,
  };
  await db.collection(COLLECTION).insertOne(session as never);
  return { token, session };
}

/** The live session behind a browser token (slides `expiresAt`), or null (unknown / expired — an expired one is dropped). */
export async function findSessionByToken(token: string): Promise<Session | null> {
  if (!token) return null;
  const db = await getDb();
  const session = toSession((await db.collection(COLLECTION).findOne({ _id: hashToken(token) as never })) as Record<string, unknown> | null);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await revokeSession(session._id);
    return null;
  }
  const slid = new Date(now + session.hours * 3600_000);
  if (slid.getTime() - session.expiresAt.getTime() >= SLIDE_EVERY_MS) {
    await db.collection(COLLECTION).updateOne({ _id: session._id as never }, { $set: { expiresAt: slid } });
    session.expiresAt = slid;
  }
  return session;
}

export async function findSession(id: string): Promise<Session | null> {
  const db = await getDb();
  return toSession((await db.collection(COLLECTION).findOne({ _id: id as never })) as Record<string, unknown> | null);
}

/** The live sessions of a person, newest expiry first (background work acting for them — e.g. an import catch-up). */
export async function listLiveSessionsOf(personId: string): Promise<Session[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find({ personId, expiresAt: { $gt: new Date() } }).sort({ expiresAt: -1 }).limit(10).toArray();
  return docs.map((d) => toSession(d as Record<string, unknown>)).filter((x): x is Session => x !== null);
}

/** Role switch: another role of the list; the offline key rotates (the offline copy is role-scoped and gets wiped). */
export async function switchSessionRole(id: string, role: CoreRole): Promise<Session | null> {
  const db = await getDb();
  forgetSessionValidation(id);
  const res = await db.collection(COLLECTION).findOneAndUpdate({ _id: id as never }, { $set: { activeRole: role, offlineKey: newOfflineKey() } }, { returnDocument: "after" });
  return toSession(res as Record<string, unknown> | null);
}

/** History / camp switch (coordenação). The offline key rotates too. */
export async function switchSessionCamp(id: string, campId: string): Promise<Session | null> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).findOneAndUpdate({ _id: id as never }, { $set: { campId, offlineKey: newOfflineKey() } }, { returnDocument: "after" });
  return toSession(res as Record<string, unknown> | null);
}

/** A role whose membership is gone: dropped from the list (and its tokens). */
export async function dropSessionRole(session: Session, role: CoreRole): Promise<void> {
  const db = await getDb();
  const tokens = openRoleTokens(session);
  delete tokens[role];
  await db.collection(COLLECTION).updateOne({ _id: session._id as never }, { $set: { roles: session.roles.filter((r) => r !== role), roleTokens: seal(JSON.stringify(tokens)) } });
}

/** Ends a session (logout, SESSION_ENDED, access window…): the record goes and its sockets close (4401). */
export async function revokeSession(id: string): Promise<void> {
  const db = await getDb();
  forgetSessionValidation(id);
  await db.collection(COLLECTION).deleteOne({ _id: id as never });
  closeSessionSockets(id);
}

/** Logs a person out everywhere (every session of that person id). */
export async function revokePersonSessions(personId: string): Promise<number> {
  const db = await getDb();
  const deleted = (await db.collection(COLLECTION).deleteMany({ personId })).deletedCount;
  closePersonSockets(personId);
  return deleted;
}

export async function ensureSessionIndexes(): Promise<void> {
  const db = await getDb();
  await ensureIndex(db.collection(COLLECTION), { personId: 1 }, { name: "personId_v2" }); // sessions are keyed by personId now (decision 91: new name)
  // Mongo drops expired sessions by itself (the sliding update moves the deadline)
  await ensureIndex(db.collection(COLLECTION), { expiresAt: 1 }, { expireAfterSeconds: 0 });
}
