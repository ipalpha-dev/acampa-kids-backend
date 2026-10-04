import { rawDb } from "../db";

/**
 * `ipalphaLoginStates` — one row per IPAlpha sign-in in flight:
 * `{ state, codeVerifier, createdAt }`. Lives at most 10 minutes (TTL index)
 * and is consumed exactly once (findOneAndDelete). Not camp-scoped: a sign-in
 * belongs to no camp. Holds no person data and no token.
 */
const COLLECTION = "ipalphaLoginStates";
export const LOGIN_STATE_TTL_SECONDS = 10 * 60;

export async function saveLoginState(state: string, codeVerifier: string, now = new Date()): Promise<void> {
  const db = await rawDb();
  await db.collection(COLLECTION).insertOne({ state, codeVerifier, createdAt: now });
}

/**
 * Takes the state out (one-time). Null when unknown, already used or older than
 * the TTL — Mongo's TTL monitor only runs every minute, so age is checked here too.
 */
export async function consumeLoginState(state: string, now = new Date()): Promise<{ codeVerifier: string } | null> {
  if (!state) return null;
  const db = await rawDb();
  const doc = await db.collection(COLLECTION).findOneAndDelete({ state });
  if (!doc) return null;
  const createdAt = doc.createdAt instanceof Date ? doc.createdAt : new Date(0);
  if (now.getTime() - createdAt.getTime() > LOGIN_STATE_TTL_SECONDS * 1000) return null;
  return typeof doc.codeVerifier === "string" ? { codeVerifier: doc.codeVerifier } : null;
}

export async function ensureLoginStateIndexes(): Promise<void> {
  const db = await rawDb();
  await db.collection(COLLECTION).createIndex({ state: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ createdAt: 1 }, { expireAfterSeconds: LOGIN_STATE_TTL_SECONDS });
}
