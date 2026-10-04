import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createFakeCore,
  createTestKeys,
  disableIpalpha,
  enableIpalpha,
  json,
  resetData,
  startTestDb,
  stopTestDb,
  testApp,
  TEST_ENV,
  userDoc,
  type FakeCore,
  type TestKeys,
} from "../testing/ipalphaHarness";
import { ensureLoginAccount, findByPersonId } from "../models/users";
import { hashCode } from "../services/otp";
import { mapRelayError, rolloverEdition } from "../services/ipalpha";
import { IpalphaRejected, IpalphaUnavailable } from "../services/ipalpha/coreClient";
import { rawDb } from "../db";
import { config } from "../config";

const PHONE = "+5511987650011";
const PERSON = "person-relay-1";
const START = "POST /internal/login/relay/start";
const VERIFY = "POST /internal/login/relay/verify";
const TOKEN = "POST /oauth/token";

let keys: TestKeys;
let core: FakeCore;
const call = testApp();

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  enableIpalpha(core, keys);
  core.on(TOKEN, () => json({ access_token: "system-token-1", token_type: "Bearer", expires_in: 300, scope: "login:relay" }));
  core.on(START, () => json({ challengeId: "challenge-1", codeLength: 6, expiresInSec: 300, sessionIdleHours: 12 }));
  core.on(VERIFY, () => json({ personId: PERSON, sessionIdleHours: 12, amr: ["sms"] }));
  await ensureLoginAccount("Admin Teste", PHONE, "admin");
});

const request = (headers: Record<string, string> = {}) => call("/api/auth/otp/request", { phone: PHONE, locale: "pt" }, headers);
const verify = (code = "123456") => call("/api/auth/otp/verify", { phone: PHONE, code, locale: "pt" });

function rejectWith(key: string, status: number, body: Record<string, unknown>) {
  core.on(key, () => json({ statusCode: status, message: "x", ...body }, status));
}

describe("legacy phone login without IPAlpha (unchanged)", () => {
  test("request stores a local hashed code and answers the legacy shape; core is never called", async () => {
    disableIpalpha();
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, phone: PHONE, role: "admin", roles: ["admin"], expireMinutes: config.otp.expireMinutes, delivery: "mock" });
    const otp = (await userDoc(PHONE))!.otp as Record<string, unknown>;
    expect(otp.provider).toBe("local");
    expect(typeof otp.codeHash).toBe("string");
    expect(core.calls).toHaveLength(0);
  });

  test("verify: wrong code counts down, the right one opens a SESSION_HOURS session", async () => {
    disableIpalpha();
    await request();
    await (await rawDb()).collection("users").updateOne({ phone: PHONE }, { $set: { "otp.codeHash": hashCode("123456") } });
    const wrong = await verify("000000");
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: "OTP_INVALID", attemptsLeft: config.otp.maxAttempts - 1 });
    const ok = await verify("123456");
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ phone: PHONE, activeRole: "admin" });
    expect(Math.round((Date.parse(ok.body.tokenExpiresAt) - Date.now()) / 3_600_000)).toBe(config.sessionHours);
    expect((await userDoc(PHONE))!.ipalphaPersonIds).toBeUndefined();
    expect(core.calls).toHaveLength(0);
  });
});

describe("legacy phone login relayed through IPAlpha", () => {
  test("request → relay/start with a system token, first X-Forwarded-For hop and language; challenge stored, no code", async () => {
    const res = await request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, phone: PHONE, role: "admin", roles: ["admin"], expireMinutes: 5, delivery: "sms" });
    expect(res.body.reused).toBeUndefined();

    const [start] = core.callsTo(START);
    expect(start.headers.get("authorization")).toBe("Bearer system-token-1");
    expect(start.json).toEqual({ clientId: TEST_ENV.IPALPHA_CLIENT_ID, entryPoint: TEST_ENV.IPALPHA_ENTRY_POINT, phone: PHONE, language: "pt-BR", clientIp: "203.0.113.7" });
    const [tokenCall] = core.callsTo(TOKEN);
    expect(tokenCall.form!.get("grant_type")).toBe("client_credentials");
    expect(tokenCall.form!.get("client_id")).toBe(TEST_ENV.IPALPHA_SYSTEM_CLIENT_ID);
    expect(tokenCall.form!.get("resource")).toBe("ipalpha:auth");
    expect(tokenCall.form!.get("scope")).toBe("login:relay");

    const otp = (await userDoc(PHONE))!.otp as Record<string, unknown>;
    expect(otp).toMatchObject({ provider: "ipalpha", challengeId: "challenge-1", attempts: 0, requestedRole: "admin" });
    expect(otp.codeHash).toBeUndefined();
  });

  test("a second request inside the cooldown reuses the challenge; the system token is cached", async () => {
    await request();
    const again = await request();
    expect(again.body).toMatchObject({ success: true, reused: true, delivery: "sms" });
    expect(core.callsTo(START)).toHaveLength(1);
    // a later fresh request (cooldown over) asks again but reuses the cached system token
    await (await rawDb()).collection("users").updateOne({ phone: PHONE }, { $set: { "otp.requestedAt": new Date(Date.now() - 10 * 60_000) } });
    await request();
    expect(core.callsTo(START)).toHaveLength(2);
    expect(core.callsTo(TOKEN)).toHaveLength(1);
  });

  test("an expired system token (401) is refreshed once", async () => {
    let n = 0;
    core.on(START, () => (n++ === 0 ? json({ reason: "invalidToken" }, 401) : json({ challengeId: "challenge-2", codeLength: 6, expiresInSec: 300 })));
    const res = await request();
    expect(res.status).toBe(200);
    expect(core.callsTo(TOKEN)).toHaveLength(2);
  });

  test("personNotFound → today's local SMS path (local hashed code)", async () => {
    rejectWith(START, 404, { reason: "personNotFound" });
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.body.delivery).toBe("mock");
    const otp = (await userDoc(PHONE))!.otp as Record<string, unknown>;
    expect(otp.provider).toBe("local");
    expect(typeof otp.codeHash).toBe("string");
    // and that local code is verified locally, without core
    await (await rawDb()).collection("users").updateOne({ phone: PHONE }, { $set: { "otp.codeHash": hashCode("123456") } });
    expect((await verify("123456")).status).toBe(200);
    expect(core.callsTo(VERIFY)).toHaveLength(0);
  });

  test("core unreachable → 503 IPALPHA_UNAVAILABLE (no local SMS sent)", async () => {
    core.setDown(true);
    const res = await request();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("IPALPHA_UNAVAILABLE");
    expect((await userDoc(PHONE))!.otp).toBeUndefined();
  });

  test("core 5xx → 503 IPALPHA_UNAVAILABLE", async () => {
    core.on(START, () => json({}, 500));
    expect((await request()).body.error.code).toBe("IPALPHA_UNAVAILABLE");
  });

  test("request: resendTooSoon → OTP_COOLDOWN; tooManyRequests → OTP_COOLDOWN; tooManyAttempts → ACCOUNT_FROZEN (frozen locally)", async () => {
    rejectWith(START, 429, { reason: "resendTooSoon", retryAfterSec: 42 });
    let res = await request();
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ code: "OTP_COOLDOWN", secondsLeft: 42 });

    rejectWith(START, 429, { reason: "tooManyRequests" });
    res = await request();
    expect(res.body.error).toMatchObject({ code: "OTP_COOLDOWN", secondsLeft: config.otp.resendCooldownSeconds });
    expect((await userDoc(PHONE))!.frozenUntil).toBeUndefined();

    rejectWith(START, 429, { reason: "tooManyAttempts", retryAfterSec: 600 });
    res = await request();
    expect(res.status).toBe(423);
    expect(res.body.error).toMatchObject({ code: "ACCOUNT_FROZEN", minutesLeft: 10 });
    expect((await userDoc(PHONE))!.frozenUntil).toBeInstanceOf(Date);
    // the local freeze now answers by itself, without asking core
    const before = core.callsTo(START).length;
    expect((await request()).status).toBe(423);
    expect(core.callsTo(START)).toHaveLength(before);
  });

  test("verify success → relay/verify, personId bound, otp cleared, session sized by sessionIdleHours", async () => {
    await request();
    const res = await verify("654321");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, user: { phone: PHONE, activeRole: "admin" } });
    expect(Math.round((Date.parse(res.body.tokenExpiresAt) - Date.now()) / 3_600_000)).toBe(12);
    expect(core.callsTo(VERIFY)[0].json).toEqual({ clientId: TEST_ENV.IPALPHA_CLIENT_ID, entryPoint: TEST_ENV.IPALPHA_ENTRY_POINT, challengeId: "challenge-1", code: "654321" });
    const doc = (await userDoc(PHONE))!;
    expect(doc.ipalphaPersonIds).toEqual([PERSON]);
    expect(doc.otp).toBeNull();
    expect((await findByPersonId(PERSON))!.phone).toBe(PHONE);
  });

  test("verify invalidCode → OTP_INVALID (attemptsLeft passed through when auth sends it)", async () => {
    await request();
    rejectWith(VERIFY, 401, { reason: "invalidCode" });
    let res = await verify();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
    expect(res.body.error.attemptsLeft).toBeUndefined();
    expect(((await userDoc(PHONE))!.otp as Record<string, unknown>).attempts).toBe(1);

    rejectWith(VERIFY, 401, { reason: "invalidCode", attemptsLeft: 1 });
    res = await verify();
    expect(res.body.error).toMatchObject({ code: "OTP_INVALID", attemptsLeft: 1 });
  });

  test("verify tryAgainLater → ACCOUNT_FROZEN with minutesLeft, frozen locally, challenge dropped", async () => {
    await request();
    rejectWith(VERIFY, 429, { reason: "tryAgainLater", retryAfterSec: 90 });
    const res = await verify();
    expect(res.status).toBe(423);
    expect(res.body.error).toMatchObject({ code: "ACCOUNT_FROZEN", minutesLeft: 2 });
    const doc = (await userDoc(PHONE))!;
    expect(doc.otp).toBeNull();
    expect((doc.frozenUntil as Date).getTime()).toBeGreaterThan(Date.now());
  });

  test("verify tooManyAttempts → ACCOUNT_FROZEN", async () => {
    await request();
    rejectWith(VERIFY, 429, { reason: "tooManyAttempts" });
    const res = await verify();
    expect(res.body.error).toMatchObject({ code: "ACCOUNT_FROZEN", minutesLeft: config.otp.freezeMinutes });
  });

  test("verify challengeExpired → OTP_EXPIRED, challenge dropped", async () => {
    await request();
    rejectWith(VERIFY, 410, { reason: "challengeExpired" });
    const res = await verify();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("OTP_EXPIRED");
    expect((await userDoc(PHONE))!.otp).toBeNull();
  });

  test("verify with core down → 503 IPALPHA_UNAVAILABLE, challenge kept for a retry", async () => {
    await request();
    core.setDown(true);
    const res = await verify();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("IPALPHA_UNAVAILABLE");
    expect(((await userDoc(PHONE))!.otp as Record<string, unknown>).challengeId).toBe("challenge-1");
  });

  test("a relayed challenge left pending when IPAlpha is switched off → OTP_EXPIRED", async () => {
    await request();
    disableIpalpha();
    expect((await verify()).body.error.code).toBe("OTP_EXPIRED");
  });

  test("the sessionIdleHours learned from relay sizes the next IPAlpha-button session too", async () => {
    await request(); // relay answer carries sessionIdleHours: 12
    const { sessionIdleHours } = await import("../services/ipalpha");
    expect(sessionIdleHours()).toBe(12);
  });
});

describe("mapRelayError (every auth reason)", () => {
  const rejected = (reason: string, body: Record<string, unknown> = {}) => new IpalphaRejected(400, reason, body);
  const cases: [string, "request" | "verify", unknown, string | "fallback", number?][] = [
    ["invalidCode", "verify", rejected("invalidCode"), "OTP_INVALID", 400],
    ["tryAgainLater", "verify", rejected("tryAgainLater", { retryAfterSec: 30 }), "ACCOUNT_FROZEN", 423],
    ["tooManyAttempts", "request", rejected("tooManyAttempts"), "ACCOUNT_FROZEN", 423],
    ["tooManyRequests", "request", rejected("tooManyRequests"), "OTP_COOLDOWN", 429],
    ["challengeExpired", "verify", rejected("challengeExpired"), "OTP_EXPIRED", 400],
    ["resendTooSoon", "request", rejected("resendTooSoon", { retryAfterSec: 5 }), "OTP_COOLDOWN", 429],
    ["personNotFound on request", "request", rejected("personNotFound"), "fallback"],
    ["personNotFound on verify", "verify", rejected("personNotFound"), "IPALPHA_UNAVAILABLE", 503],
    ["appMismatch (misconfiguration)", "request", rejected("appMismatch"), "IPALPHA_UNAVAILABLE", 503],
    ["unavailable", "request", new IpalphaUnavailable("down"), "IPALPHA_UNAVAILABLE", 503],
    ["unexpected error", "verify", new Error("boom"), "IPALPHA_UNAVAILABLE", 503],
  ];
  for (const [name, phase, err, code, status] of cases) {
    test(`${name} → ${code}`, () => {
      const out = mapRelayError(phase, err);
      if (code === "fallback") return expect(out.kind).toBe("fallback");
      expect(out.kind).toBe("error");
      if (out.kind !== "error") return;
      expect(out.error.code).toBe(code);
      expect(out.status as number).toBe(status!);
    });
  }
});

describe("camp activation → edition rollover (best effort)", () => {
  test("POSTs current-by-year for the camp's year with a projects:editions system token", async () => {
    core.on(`POST /projects/${TEST_ENV.IPALPHA_PROJECT_ID}/editions/current-by-year`, () => json({ id: "edition-2027", current: true }));
    expect(await rolloverEdition(2027)).toBe("ok");
    const [edition] = core.callsTo(`POST /projects/${TEST_ENV.IPALPHA_PROJECT_ID}/editions/current-by-year`);
    expect(edition.query.get("year")).toBe("2027");
    expect(core.callsTo(TOKEN)[0].form!.get("scope")).toBe("projects:editions");
    expect(core.callsTo(TOKEN)[0].form!.get("resource")).toBe("ipalpha:projects");
  });

  test("a refusal or an outage never throws", async () => {
    core.on(`POST /projects/${TEST_ENV.IPALPHA_PROJECT_ID}/editions/current-by-year`, () => json({ reason: "notNewerYear" }, 409));
    expect(await rolloverEdition(2020)).toBe("failed");
    core.setDown(true);
    expect(await rolloverEdition(2027)).toBe("failed");
  });

  test("skipped without IPAlpha or without a project", async () => {
    const { IPALPHA_PROJECT_ID: _drop, ...env } = TEST_ENV;
    enableIpalpha(core, keys, env);
    expect(await rolloverEdition(2027)).toBe("skipped");
    disableIpalpha();
    expect(await rolloverEdition(2027)).toBe("skipped");
    expect(core.calls).toHaveLength(0);
  });
});
