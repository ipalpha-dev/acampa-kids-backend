import { ObjectId } from "mongodb";
import { getDb, rawDb } from "../db";
import type { CampDeleteOtp } from "../models/camps";
import { wipeGallery } from "../models/cleanup";
import { deleteFile } from "../models/files";
import { withCamp } from "./campContext";
import { SCOPED } from "./campScope";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/** A 6-digit confirmation code (sent through the `acampa-camp-delete-code` template; only its hash is stored). */
export function generateDeleteCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashDeleteCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function verifyDeleteCode(code: string, hash: string): boolean {
  const a = Buffer.from(hashDeleteCode(code), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const DELETE_CODE_MAX_ATTEMPTS = 3;

export interface CampDeleteCodeError {
  code: "CODE_EXPIRED" | "INVALID_CODE" | "TOO_MANY_ATTEMPTS";
  status: 410 | 401 | 429;
  message: string;
  attemptsLeft?: number;
}

export type CampDeleteCodeResult =
  | { ok: true }
  | { ok: false; error: CampDeleteCodeError; clear: boolean; attempts?: number };

/**
 * Pure validation of a camp-delete confirmation code — no I/O, so the route
 * only has to act on the verdict (clear the pending OTP, bump its attempts
 * counter, or run the deletion). `now` is injectable for tests.
 */
export function evaluateCampDeleteCode(otp: CampDeleteOtp | null, requesterId: string, code: string, now: Date = new Date()): CampDeleteCodeResult {
  if (!otp || otp.requestedByPersonId !== requesterId) {
    return { ok: false, clear: false, error: { code: "CODE_EXPIRED", status: 410, message: "Peça um novo código." } };
  }
  if (otp.expiresAt <= now) {
    return { ok: false, clear: true, error: { code: "CODE_EXPIRED", status: 410, message: "O código expirou. Peça um novo código." } };
  }
  if (!code || !verifyDeleteCode(code, otp.codeHash)) {
    const attempts = otp.attempts + 1;
    if (attempts >= DELETE_CODE_MAX_ATTEMPTS) {
      return { ok: false, clear: true, error: { code: "TOO_MANY_ATTEMPTS", status: 429, message: "Muitas tentativas. Peça um novo código." } };
    }
    return { ok: false, clear: false, attempts, error: { code: "INVALID_CODE", status: 401, message: "Código incorreto.", attemptsLeft: DELETE_CODE_MAX_ATTEMPTS - attempts } };
  }
  return { ok: true };
}

/**
 * Wipes every trace of one camp: its SCOPED collections (through the scoped
 * `getDb()`, so `campId` is added automatically), its gallery bytes on disk,
 * its `userCampState` rows and sessions (both UNSCOPED, filtered explicitly),
 * and finally the registry entry itself. Returns the deleted-document count
 * per collection, for the log line and the API response.
 */
export async function deleteCamp(campId: string): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};

  await withCamp(campId, async () => {
    const { count, fileIds } = await wipeGallery();
    removed.gallery = count;
    await Promise.all(fileIds.map((id) => deleteFile(id)));

    const db = await getDb();
    for (const name of SCOPED) {
      if (name === "gallery") continue;
      const { deletedCount } = await db.collection(name).deleteMany({});
      removed[name] = deletedCount;
    }
  });

  const raw = await rawDb();
  const [userCampState, sessions] = await Promise.all([
    raw.collection("userCampState").deleteMany({ campId }),
    raw.collection("sessions").deleteMany({ campId }),
  ]);
  removed.userCampState = userCampState.deletedCount;
  removed.sessions = sessions.deletedCount;

  if (ObjectId.isValid(campId)) await raw.collection("camps").deleteOne({ _id: new ObjectId(campId) });

  return removed;
}
