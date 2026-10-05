import { describe, expect, test } from "bun:test";
import { hashDeleteCode as hashCode } from "./campDelete";
import { DELETE_CODE_MAX_ATTEMPTS, evaluateCampDeleteCode, type CampDeleteCodeResult } from "./campDelete";
import type { CampDeleteOtp } from "../models/camps";

const CODE = "123456";
const now = new Date("2026-01-01T12:00:00Z");

function otp(patch: Partial<CampDeleteOtp> = {}): CampDeleteOtp {
  return { codeHash: hashCode(CODE), requestedByPersonId: "user-1", expiresAt: new Date(now.getTime() + 5 * 60_000), attempts: 0, ...patch };
}

function errorCode(result: CampDeleteCodeResult): string | null {
  return result.ok ? null : result.error.code;
}

describe("evaluateCampDeleteCode", () => {
  test("accepts the right code from the requester before it expires", () => {
    expect(evaluateCampDeleteCode(otp(), "user-1", CODE, now)).toEqual({ ok: true });
  });

  test("rejects when there is no pending code", () => {
    const result = evaluateCampDeleteCode(null, "user-1", CODE, now);
    expect(errorCode(result)).toBe("CODE_EXPIRED");
    expect(result.ok ? null : result.clear).toBe(false);
  });

  test("rejects a code requested by someone else", () => {
    const result = evaluateCampDeleteCode(otp({ requestedByPersonId: "user-2" }), "user-1", CODE, now);
    expect(errorCode(result)).toBe("CODE_EXPIRED");
  });

  test("rejects an expired code and asks to clear it", () => {
    const result = evaluateCampDeleteCode(otp({ expiresAt: new Date(now.getTime() - 1000) }), "user-1", CODE, now);
    expect(errorCode(result)).toBe("CODE_EXPIRED");
    expect(result.ok ? null : result.clear).toBe(true);
  });

  test("a wrong code below the attempt limit bumps attempts and reports attemptsLeft", () => {
    const result = evaluateCampDeleteCode(otp({ attempts: 0 }), "user-1", "000000", now);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("INVALID_CODE");
    expect(result.clear).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error.attemptsLeft).toBe(DELETE_CODE_MAX_ATTEMPTS - 1);
  });

  test("a wrong code at the attempt limit locks out and asks to clear it", () => {
    const result = evaluateCampDeleteCode(otp({ attempts: DELETE_CODE_MAX_ATTEMPTS - 1 }), "user-1", "000000", now);
    expect(errorCode(result)).toBe("TOO_MANY_ATTEMPTS");
    expect(result.ok ? null : result.clear).toBe(true);
  });
});
