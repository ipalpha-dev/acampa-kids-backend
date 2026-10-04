import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createFakeCore,
  createTestKeys,
  disableIpalpha,
  enableIpalpha,
  insertCamper,
  insertStaff,
  json,
  resetData,
  signPersonToken,
  startTestDb,
  stopTestDb,
  testApp,
  TEST_ENV,
  userDoc,
  type FakeCore,
  type TestKeys,
} from "../testing/ipalphaHarness";
import { ensureLoginAccount } from "../models/users";
import { updateSettings } from "../models/settings";
import { rawDb } from "../db";
import { config } from "../config";

const ADMIN_PHONE = "+5511987650001";
const STAFF_PHONE = "+5511987650002";
const PARENT_PHONE = "+5511987650003";
const PERSON = "person-test-1";

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
  core.on("POST /oauth/par", () => json({ request_uri: "urn:ietf:params:oauth:request_uri:test-1", expires_in: 600 }));
});

/** start → the state the backend generated (read back from the PAR call). */
async function startLogin(personHint?: string): Promise<string> {
  const res = await call("/api/auth/ipalpha/start", personHint ? { personHint } : {});
  expect(res.status).toBe(200);
  return core.callsTo("POST /oauth/par").at(-1)!.form!.get("state")!;
}

function tokenAnswer(token: string) {
  core.on("POST /oauth/token", () => json({ token_type: "Bearer", tokens_by_resource: { "ipalpha:persons": { access_token: token, expires_in: 300 } } }));
}

function phonesAnswer(phones: { e164: string; verified: boolean }[]) {
  core.on(`GET /persons/${PERSON}/data/phone`, () => json({ phones }));
}

describe("GET /api/auth/ipalpha/config", () => {
  test("disabled when the env is incomplete: button hidden, nothing else exposed", async () => {
    disableIpalpha();
    const res = await call("/api/auth/ipalpha/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, authOrigin: null, clientId: null, entryPoint: null });
  });

  test("enabled: public values only, never secrets", async () => {
    const res = await call("/api/auth/ipalpha/config");
    expect(res.body).toEqual({ enabled: true, authOrigin: TEST_ENV.IPALPHA_AUTH_ORIGIN, clientId: TEST_ENV.IPALPHA_CLIENT_ID, entryPoint: TEST_ENV.IPALPHA_ENTRY_POINT });
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  test("start / complete answer 404 IPALPHA_DISABLED when off", async () => {
    disableIpalpha();
    expect((await call("/api/auth/ipalpha/start", {})).body.error.code).toBe("IPALPHA_DISABLED");
    expect((await call("/api/auth/ipalpha/complete", { code: "x", state: "y" })).status).toBe(404);
  });
});

describe("POST /api/auth/ipalpha/start", () => {
  test("stores {state, codeVerifier} and PARs with secret + PKCE S256 → popup URL with request_uri", async () => {
    const res = await call("/api/auth/ipalpha/start", { personHint: "person-hint_1" });
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.origin).toBe(TEST_ENV.IPALPHA_AUTH_ORIGIN);
    expect(url.searchParams.get("request_uri")).toBe("urn:ietf:params:oauth:request_uri:test-1");
    expect(url.searchParams.get("client_id")).toBe(TEST_ENV.IPALPHA_CLIENT_ID);
    expect(url.searchParams.get("entry_point")).toBe(TEST_ENV.IPALPHA_ENTRY_POINT);
    expect(res.body.url).not.toContain("secret");

    const form = core.callsTo("POST /oauth/par")[0].form!;
    expect(form.get("client_secret")).toBe(TEST_ENV.IPALPHA_CLIENT_SECRET);
    expect(form.get("response_mode")).toBe("web_message");
    expect(form.get("response_type")).toBe("code");
    expect(form.get("resource")).toBe("ipalpha:persons");
    expect(form.get("project_id")).toBe(TEST_ENV.IPALPHA_PROJECT_ID);
    expect(form.get("login_hint")).toBe("person-hint_1");
    expect(form.get("redirect_uri")).toBe(TEST_ENV.IPALPHA_REDIRECT_URI);
    expect(form.get("code_challenge_method")).toBe("S256");

    const stored = await (await rawDb()).collection("ipalphaLoginStates").findOne({ state: form.get("state") });
    expect(stored).not.toBeNull();
    const challenge = createHash("sha256").update(stored!.codeVerifier as string).digest("base64url");
    expect(form.get("code_challenge")).toBe(challenge);
  });

  test("no project id → no project_id; an odd personHint is dropped", async () => {
    const { IPALPHA_PROJECT_ID: _drop, ...env } = TEST_ENV;
    enableIpalpha(core, keys, env);
    await call("/api/auth/ipalpha/start", { personHint: "<script>" });
    const form = core.callsTo("POST /oauth/par")[0].form!;
    expect(form.has("project_id")).toBe(false);
    expect(form.has("login_hint")).toBe(false);
  });

  test("core down → 503 IPALPHA_UNAVAILABLE and no state left behind", async () => {
    core.setDown(true);
    const res = await call("/api/auth/ipalpha/start", {});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("IPALPHA_UNAVAILABLE");
    expect(await (await rawDb()).collection("ipalphaLoginStates").countDocuments()).toBe(0);
  });
});

describe("POST /api/auth/ipalpha/complete", () => {
  test("unknown state → IPALPHA_STATE_INVALID", async () => {
    const res = await call("/api/auth/ipalpha/complete", { code: "c", state: "never-issued" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IPALPHA_STATE_INVALID");
  });

  test("a state is one-time: the replay is refused", async () => {
    await ensureLoginAccount("Admin Teste", ADMIN_PHONE, "admin");
    tokenAnswer(await signPersonToken(keys, PERSON));
    phonesAnswer([{ e164: ADMIN_PHONE, verified: true }]);
    const state = await startLogin();
    expect((await call("/api/auth/ipalpha/complete", { code: "c1", state })).status).toBe(200);
    const replay = await call("/api/auth/ipalpha/complete", { code: "c1", state });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("IPALPHA_STATE_INVALID");
  });

  test("a state older than 10 minutes is refused", async () => {
    const state = await startLogin();
    await (await rawDb()).collection("ipalphaLoginStates").updateOne({ state }, { $set: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    expect((await call("/api/auth/ipalpha/complete", { code: "c", state })).body.error.code).toBe("IPALPHA_STATE_INVALID");
  });

  test("the popup's error → IPALPHA_DENIED (state consumed)", async () => {
    const state = await startLogin();
    const res = await call("/api/auth/ipalpha/complete", { error: "access_denied", state });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("IPALPHA_DENIED");
    expect((await call("/api/auth/ipalpha/complete", { code: "c", state })).body.error.code).toBe("IPALPHA_STATE_INVALID");
  });

  test("token exchange sends verifier + secret; invalid_grant → IPALPHA_CODE_INVALID", async () => {
    core.on("POST /oauth/token", () => json({ error: "invalid_grant", reason: "invalidGrant" }, 400));
    const state = await startLogin();
    const res = await call("/api/auth/ipalpha/complete", { code: "bad-code", state });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IPALPHA_CODE_INVALID");
    const form = core.callsTo("POST /oauth/token")[0].form!;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("bad-code");
    expect(form.get("client_secret")).toBe(TEST_ENV.IPALPHA_CLIENT_SECRET);
    const verifier = form.get("code_verifier")!;
    const par = core.callsTo("POST /oauth/par")[0].form!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(par.get("code_challenge")!);
  });

  test("token exchange 5xx → 503 IPALPHA_UNAVAILABLE", async () => {
    core.on("POST /oauth/token", () => json({}, 502));
    const state = await startLogin();
    expect((await call("/api/auth/ipalpha/complete", { code: "c", state })).status).toBe(503);
  });

  test("no persons token in the answer → IPALPHA_DENIED", async () => {
    core.on("POST /oauth/token", () => json({ token_type: "Bearer", tokens_by_resource: {} }));
    const state = await startLogin();
    expect((await call("/api/auth/ipalpha/complete", { code: "c", state })).body.error.code).toBe("IPALPHA_DENIED");
  });

  const badTokens: [string, (k: TestKeys) => Promise<string>][] = [
    ["wrong audience", (k) => signPersonToken(k, PERSON, { aud: "ipalpha:projects" })],
    ["wrong issuer", (k) => signPersonToken(k, PERSON, { iss: "https://evil.test.invalid" })],
    ["wrong token_use", (k) => signPersonToken(k, PERSON, { token_use: "church_access" })],
    ["another app's token (azp)", (k) => signPersonToken(k, PERSON, { azp: "someone-else" })],
    ["unknown signing key", (k) => signPersonToken(k, PERSON, {}, k.otherPrivateKey)],
  ];
  for (const [name, make] of badTokens) {
    test(`${name} → IPALPHA_CODE_INVALID, no account touched`, async () => {
      await ensureLoginAccount("Admin Teste", ADMIN_PHONE, "admin");
      tokenAnswer(await make(keys));
      phonesAnswer([{ e164: ADMIN_PHONE, verified: true }]);
      const state = await startLogin();
      const res = await call("/api/auth/ipalpha/complete", { code: "c", state });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IPALPHA_CODE_INVALID");
      expect(core.callsTo(`GET /persons/${PERSON}/data/phone`)).toHaveLength(0);
      expect((await userDoc(ADMIN_PHONE))!.ipalphaPersonIds).toBeUndefined();
    });
  }

  test("first login binds via the verified phone; the second goes by personId without reading persons", async () => {
    await ensureLoginAccount("Admin Teste", ADMIN_PHONE, "admin");
    const token = await signPersonToken(keys, PERSON);
    tokenAnswer(token);
    phonesAnswer([{ e164: ADMIN_PHONE, verified: true }]);

    const first = await call("/api/auth/ipalpha/complete", { code: "c1", state: await startLogin() });
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(typeof first.body.token).toBe("string");
    expect(first.body.user).toMatchObject({ phone: ADMIN_PHONE, activeRole: "admin", roles: ["admin"] });
    expect(first.body.camp).toHaveProperty("id");
    expect(JSON.stringify(first.body)).not.toContain(token);
    // the persons token is the person's own, used once
    const read = core.callsTo(`GET /persons/${PERSON}/data/phone`);
    expect(read).toHaveLength(1);
    expect(read[0].headers.get("authorization")).toBe(`Bearer ${token}`);
    const doc = (await userDoc(ADMIN_PHONE))!;
    expect(doc.ipalphaPersonIds).toEqual([PERSON]);
    // nothing else from core is stored on the account
    expect(Object.keys(doc).sort()).toEqual(["_id", "createdAt", "frozenUntil", "ipalphaPersonIds", "locale", "name", "otp", "phone", "roles", "updatedAt"]);
    // session length: SESSION_HOURS until auth-api told us its sessionIdleHours
    const hours = (Date.parse(first.body.tokenExpiresAt) - Date.now()) / 3_600_000;
    expect(Math.round(hours)).toBe(config.sessionHours);

    const second = await call("/api/auth/ipalpha/complete", { code: "c2", state: await startLogin() });
    expect(second.status).toBe(200);
    expect(second.body.user.phone).toBe(ADMIN_PHONE);
    expect(core.callsTo(`GET /persons/${PERSON}/data/phone`)).toHaveLength(1);
  });

  test("first login provisions a roster member's account like the phone login does", async () => {
    await insertStaff("Equipe Teste", STAFF_PHONE);
    tokenAnswer(await signPersonToken(keys, PERSON));
    phonesAnswer([{ e164: STAFF_PHONE, verified: true }]);
    const res = await call("/api/auth/ipalpha/complete", { code: "c", state: await startLogin() });
    expect(res.status).toBe(200);
    expect(res.body.user.activeRole).toBe("staff");
    expect((await userDoc(STAFF_PHONE))!.ipalphaPersonIds).toEqual([PERSON]);
  });

  test("an unverified phone proves nothing → NO_PROFILE", async () => {
    await ensureLoginAccount("Admin Teste", ADMIN_PHONE, "admin");
    tokenAnswer(await signPersonToken(keys, PERSON));
    phonesAnswer([{ e164: ADMIN_PHONE, verified: false }]);
    const res = await call("/api/auth/ipalpha/complete", { code: "c", state: await startLogin() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NO_PROFILE");
    expect((await userDoc(ADMIN_PHONE))!.ipalphaPersonIds).toBeUndefined();
  });

  test("a person with no Acampa account → NO_PROFILE", async () => {
    tokenAnswer(await signPersonToken(keys, PERSON));
    phonesAnswer([{ e164: "+5511987659999", verified: true }]);
    const res = await call("/api/auth/ipalpha/complete", { code: "c", state: await startLogin() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NO_PROFILE");
  });

  test("an account whose data gives no profile (ex-responsible) → NO_PROFILE", async () => {
    await ensureLoginAccount("Responsável Teste", PARENT_PHONE, "parent"); // no kid enrolled
    tokenAnswer(await signPersonToken(keys, PERSON));
    phonesAnswer([{ e164: PARENT_PHONE, verified: true }]);
    const res = await call("/api/auth/ipalpha/complete", { code: "c", state: await startLogin() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NO_PROFILE");
  });

  test("persons-api down on the first login → 503", async () => {
    await ensureLoginAccount("Admin Teste", ADMIN_PHONE, "admin");
    tokenAnswer(await signPersonToken(keys, PERSON));
    core.on(`GET /persons/${PERSON}/data/phone`, () => json({}, 503));
    expect((await call("/api/auth/ipalpha/complete", { code: "c", state: await startLogin() })).body.error.code).toBe("IPALPHA_UNAVAILABLE");
  });

  test("parents' access window closed → STAFF_ACCESS_ENDED", async () => {
    await insertCamper("Criança Teste", "Responsável Teste", PARENT_PHONE);
    await updateSettings({ parentAccessWindow: { from: new Date(Date.now() - 7 * 86_400_000), until: new Date(Date.now() - 86_400_000) } });
    tokenAnswer(await signPersonToken(keys, PERSON));
    phonesAnswer([{ e164: PARENT_PHONE, verified: true }]);
    const res = await call("/api/auth/ipalpha/complete", { code: "c", state: await startLogin() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("STAFF_ACCESS_ENDED");
    expect(res.body.error.audience).toBe("parent");
  });

  test("parent inside the window lands on the parent profile", async () => {
    await insertCamper("Criança Teste", "Responsável Teste", PARENT_PHONE);
    tokenAnswer(await signPersonToken(keys, PERSON));
    phonesAnswer([{ e164: PARENT_PHONE, verified: true }]);
    const res = await call("/api/auth/ipalpha/complete", { code: "c", state: await startLogin() });
    expect(res.status).toBe(200);
    expect(res.body.user.activeRole).toBe("parent");
  });

  test("frozen account → ACCOUNT_FROZEN", async () => {
    await ensureLoginAccount("Admin Teste", ADMIN_PHONE, "admin");
    await (await rawDb()).collection("users").updateOne({ phone: ADMIN_PHONE }, { $set: { frozenUntil: new Date(Date.now() + 10 * 60_000) } });
    tokenAnswer(await signPersonToken(keys, PERSON));
    phonesAnswer([{ e164: ADMIN_PHONE, verified: true }]);
    const res = await call("/api/auth/ipalpha/complete", { code: "c", state: await startLogin() });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe("ACCOUNT_FROZEN");
    expect(res.body.error.minutesLeft).toBeGreaterThan(0);
  });
});
