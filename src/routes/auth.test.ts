import type { Session } from "../types";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createFakeCore,
  createTestKeys,
  disableIpalpha,
  emptyWorld,
  enableIpalpha,
  installFakeCore,
  json,
  resetData,
  sessionFor,
  startTestDb,
  stopTestDb,
  testApp,
  tokenAnswer,
  TEST_EDITION,
  type FakeCore,
  type FakeWorld,
  type TestKeys,
} from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { saveLoginState } from "../models/ipalphaLoginStates";
import { updateSettings } from "../models/settings";
import { setCampEditionId } from "../models/camps";
import { activeCampId } from "../services/campContext";
import { hashToken, openRoleTokens, unseal } from "../services/session";
import { mapRelayError } from "../services/ipalpha";
import { IpalphaRejected, IpalphaUnavailable } from "../services/ipalpha/coreClient";

const PERSON = "person-login-1";
const PHONE = "+5511987650011";
const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  world.names.set(PERSON, "Ana Teste");
  world.memberships.push({ personId: PERSON, role: "equipe", editionId: TEST_EDITION }, { personId: PERSON, role: "coordenacao" }, { personId: "person-helper", role: "checkin", editionId: TEST_EDITION });
  installFakeCore(core, world);
  enableIpalpha(core, keys);
});

async function sessionDoc(token: string) {
  return (await rawDb()).collection("sessions").findOne({ _id: hashToken(token) as never });
}

/** the popup's code exchange answers `roles` for PERSON */
function codeExchangeAnswers(roles: string[], extra: Record<string, unknown> = {}) {
  core.on("POST /oauth/token", async (c) => {
    if (c.form?.get("grant_type") === "client_credentials") return json({ access_token: "system", expires_in: 300 });
    return json(await tokenAnswer(keys, PERSON, roles, extra));
  });
}

async function complete() {
  await saveLoginState("state-1234567890abcdef", "verifier-1");
  return call("POST", "/api/auth/ipalpha/complete", { code: "code-1", state: "state-1234567890abcdef" });
}

describe("popup login (/api/auth/ipalpha) → per-role tokens → Acampa session", () => {
  test("config is public and hides secrets", async () => {
    const res = await call("GET", "/api/auth/ipalpha/config");
    expect(res.body).toEqual({ enabled: true, authOrigin: "https://login.test.invalid", clientId: "acampa-test-client", entryPoint: "acampa-web" });
  });

  test("start PARs persons + projects + auth, project-scoped", async () => {
    core.on("POST /oauth/par", () => json({ request_uri: "urn:par:1", expires_in: 600 }, 201));
    const res = await call("POST", "/api/auth/ipalpha/start", {});
    expect(res.status).toBe(200);
    const par = core.callsTo("POST /oauth/par")[0].form!;
    expect(par.getAll("resource")).toEqual(["ipalpha:persons", "ipalpha:projects", "ipalpha:auth"]);
    expect(par.get("project_id")).toBe("project-test-1");
    expect(par.has("edition_id")).toBe(false);
  });

  test("start asks for the ACTIVE camp's edition once the camp is mapped to one", async () => {
    await setCampEditionId(activeCampId(), TEST_EDITION);
    core.on("POST /oauth/par", () => json({ request_uri: "urn:par:1", expires_in: 600 }, 201));
    expect((await call("POST", "/api/auth/ipalpha/start", {})).status).toBe(200);
    expect(core.callsTo("POST /oauth/par")[0].form!.get("edition_id")).toBe(TEST_EDITION);
  });

  test("complete opens a session holding every role; the browser never sees a core token", async () => {
    codeExchangeAnswers(["equipe", "coordenacao", "participante"]);
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ personId: PERSON, name: "Ana Teste", activeRole: "coordenacao", audience: "admin", roles: ["coordenacao", "equipe"] });
    expect(res.body.sessionIdleHours).toBe(12);
    expect(JSON.stringify(res.body)).not.toContain("eyJ");
    const doc = await sessionDoc(res.body.token);
    expect(doc).toMatchObject({ personId: PERSON, roles: ["coordenacao", "equipe"], activeRole: "coordenacao", hours: 12 });
    // tokens are sealed (AES-GCM), never stored in clear
    expect(String(doc!.roleTokens)).not.toContain("eyJ");
    const opened = openRoleTokens(doc as never);
    expect(Object.keys(opened).sort()).toEqual(["coordenacao", "equipe"]);
    expect(opened.equipe.editionId).toBe(TEST_EDITION);
    expect(opened.coordenacao.editionId).toBe(TEST_EDITION);
  });

  test("a person with no role in the project → 403 NOT_IN_PROJECT, no session", async () => {
    codeExchangeAnswers(["participante"]);
    const res = await complete();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_IN_PROJECT");
    expect(await (await rawDb()).collection("sessions").countDocuments({})).toBe(0);
  });

  test("lands on a role whose access window is open (team window closed → responsável)", async () => {
    await updateSettings({ staffAccessWindow: { from: new Date(Date.now() + 86_400_000), until: null } });
    codeExchangeAnswers(["equipe", "responsavel"]);
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ activeRole: "responsavel", audience: "parent" });
  });

  test("every role's window closed → STAFF_ACCESS_NOT_YET", async () => {
    await updateSettings({ staffAccessWindow: { from: new Date(Date.now() + 86_400_000), until: null } });
    codeExchangeAnswers(["equipe"]);
    const res = await complete();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("STAFF_ACCESS_NOT_YET");
  });

  test("a replayed state is refused", async () => {
    codeExchangeAnswers(["equipe"]);
    expect((await complete()).status).toBe(200);
    expect((await call("POST", "/api/auth/ipalpha/complete", { code: "code-1", state: "state-1234567890abcdef" })).body.error.code).toBe("IPALPHA_STATE_INVALID");
  });

  test("core down → 503 IPALPHA_UNAVAILABLE", async () => {
    core.setDown(true);
    expect((await complete()).status).toBe(503);
  });
});

describe("SMS login through the auth-api relay v2", () => {
  test("request answers a sealed challenge (no phone kept) and verify opens the session", async () => {
    core.on("POST /internal/login/relay/start", () => json({ challengeId: "challenge-1", codeLength: 6, expiresInSec: 300, sessionIdleHours: 12 }));
    core.on("POST /internal/login/relay/verify", async () => json({ personId: PERSON, sessionIdleHours: 12, ...(await tokenAnswer(keys, PERSON, ["equipe"])) }));
    const req = await call("POST", "/api/auth/otp/request", { phone: "(11) 98765-0011", locale: "en" });
    expect(req.status).toBe(200);
    expect(req.body).toMatchObject({ success: true, codeLength: 6, delivery: "sms" });
    expect(req.body.challenge).not.toContain("challenge-1");
    expect(JSON.parse(unseal(req.body.challenge)).id).toBe("challenge-1");
    const start = core.callsTo("POST /internal/login/relay/start")[0].json as Record<string, unknown>;
    expect(start).toMatchObject({ phone: PHONE, projectId: "project-test-1", language: "en-US" });

    const ver = await call("POST", "/api/auth/otp/verify", { challenge: req.body.challenge, code: "123456" });
    expect(ver.status).toBe(200);
    expect(core.callsTo("POST /internal/login/relay/verify")[0].json).not.toHaveProperty("editionId");
    expect(ver.body.user).toMatchObject({ personId: PERSON, activeRole: "equipe", audience: "staff" });
    expect(JSON.stringify(await rawDb().then((db) => db.collection("sessions").find({}).toArray()))).not.toContain(PHONE);
  });

  test("both relay legs carry the active camp's edition", async () => {
    await setCampEditionId(activeCampId(), TEST_EDITION);
    core.on("POST /internal/login/relay/start", () => json({ challengeId: "challenge-1", codeLength: 6, expiresInSec: 300 }));
    core.on("POST /internal/login/relay/verify", async () => json({ personId: PERSON, ...(await tokenAnswer(keys, PERSON, ["equipe"])) }));
    const req = await call("POST", "/api/auth/otp/request", { phone: "(11) 98765-0011" });
    await call("POST", "/api/auth/otp/verify", { challenge: req.body.challenge, code: "123456" });
    expect(core.callsTo("POST /internal/login/relay/start")[0].json).toMatchObject({ editionId: TEST_EDITION });
    expect(core.callsTo("POST /internal/login/relay/verify")[0].json).toMatchObject({ editionId: TEST_EDITION });
  });

  test("unknown phone / no role → 404 NOT_IN_PROJECT; no local SMS ever", async () => {
    core.on("POST /internal/login/relay/start", () => json({ reason: "personNotFound" }, 404));
    const res = await call("POST", "/api/auth/otp/request", { phone: PHONE });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_IN_PROJECT");
  });

  test("a tampered challenge is refused before core is called", async () => {
    const res = await call("POST", "/api/auth/otp/verify", { challenge: "garbage", code: "123456" });
    expect(res.body.error.code).toBe("OTP_EXPIRED");
    expect(core.callsTo("POST /internal/login/relay/verify")).toHaveLength(0);
  });

  test("relay error mapping", () => {
    expect(mapRelayError("verify", new IpalphaRejected(401, "invalidCode", { attemptsLeft: 2 }))).toMatchObject({ status: 400, error: { code: "OTP_INVALID", attemptsLeft: 2 } });
    expect(mapRelayError("verify", new IpalphaRejected(429, "tryAgainLater", { retryAfterSec: 600 }))).toMatchObject({ status: 423, error: { code: "ACCOUNT_FROZEN", minutesLeft: 10 } });
    expect(mapRelayError("verify", new IpalphaRejected(403, "notInProject", {}))).toMatchObject({ status: 404, error: { code: "NOT_IN_PROJECT" } });
    expect(mapRelayError("request", new IpalphaRejected(429, "resendTooSoon", { retryAfterSec: 30 }))).toMatchObject({ status: 429, error: { code: "OTP_COOLDOWN", secondsLeft: 30 } });
    expect(mapRelayError("request", new IpalphaUnavailable("down"))).toMatchObject({ status: 503 });
  });

  test("IPAlpha not configured → nobody signs in (503)", async () => {
    disableIpalpha();
    expect((await call("POST", "/api/auth/otp/request", { phone: PHONE })).status).toBe(503);
  });
});

describe("session life", () => {
  test("/me reads the name live and lists the roles", async () => {
    const token = await sessionFor(keys, PERSON, ["equipe", "pontuacao"]);
    const me = await call("GET", "/api/auth/me", undefined, token);
    expect(me.body.user).toMatchObject({ name: "Ana Teste", roles: ["equipe", "pontuacao"], activeRole: "equipe" });
  });

  test("role switch is re-checked live in projects-api; a role gone is dropped", async () => {
    const token = await sessionFor(keys, PERSON, ["equipe", "saude"]);
    const before = String((await sessionDoc(token))!.offlineKey);
    world.memberships.push({ personId: PERSON, role: "saude", editionId: TEST_EDITION });
    const ok = await call("POST", "/api/auth/role", { role: "saude" }, token);
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ activeRole: "saude", audience: "staff" });
    expect(String((await sessionDoc(token))!.offlineKey)).not.toBe(before);

    world.memberships = world.memberships.filter((m) => m.role !== "equipe");
    const gone = await call("POST", "/api/auth/role", { role: "equipe" }, token);
    expect(gone.status).toBe(403);
    expect((await sessionDoc(token))!.roles).toEqual(["saude"]);
  });

  test("a role not in the session's list is refused without asking core", async () => {
    const token = await sessionFor(keys, PERSON, ["equipe"]);
    expect((await call("POST", "/api/auth/role", { role: "coordenacao" }, token)).status).toBe(403);
  });

  test("offline key: per session, no-store, rotated by a role switch", async () => {
    const token = await sessionFor(keys, PERSON, ["coordenacao"]);
    const res = await call("GET", "/api/auth/offline-key", undefined, token);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.key, "base64")).toHaveLength(32);
    expect(res.body).toMatchObject({ alg: "AES-GCM", role: "coordenacao", healthAllowed: true });
    const other = await sessionFor(keys, PERSON, ["equipe"]);
    const res2 = await call("GET", "/api/auth/offline-key", undefined, other);
    expect(res2.body.key).not.toBe(res.body.key);
    expect(res2.body.healthAllowed).toBe(false);
  });

  test("a 401 from core on the acting role token ends the session gracefully", async () => {
    const token = await sessionFor(keys, PERSON, ["coordenacao"]);
    const grants = openRoleTokens((await sessionDoc(token)) as never);
    world.revoked.add(grants.coordenacao.tokens["ipalpha:persons"]);
    const res = await call("GET", "/api/people/health-lists", undefined, token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_ENDED");
    expect(await sessionDoc(token)).toBeNull();
    expect((await call("GET", "/api/auth/me", undefined, token)).status).toBe(401);
  });

  test("logout drops the session", async () => {
    const token = await sessionFor(keys, PERSON, ["equipe"]);
    await call("POST", "/api/auth/logout", {}, token);
    expect(await sessionDoc(token)).toBeNull();
  });

  test("the plain team loses the session when its access window closes; helper roles do not", async () => {
    const team = await sessionFor(keys, PERSON, ["equipe"]);
    const helper = await sessionFor(keys, "person-helper", ["checkin"]);
    await updateSettings({ staffAccessWindow: { from: new Date(Date.now() - 2 * 86_400_000), until: new Date(Date.now() - 86_400_000) } });
    expect((await call("GET", "/api/auth/me", undefined, team)).status).toBe(401);
    expect((await call("GET", "/api/auth/me", undefined, helper)).status).toBe(200);
  });
});

describe("camp-only authorization stays live", () => {
  test("removed membership blocks camp reads and /me and ends the local session", async () => {
    const token = await sessionFor(keys, PERSON, ["coordenacao"]);
    world.memberships = [];
    const res = await call("GET", "/api/bedrooms", undefined, token);
    expect(res.status).toBe(401);
    expect(await sessionDoc(token)).toBeNull();
    expect((await call("GET", "/api/auth/me", undefined, token)).status).toBe(401);
  });

  test("revoked projects token blocks camp-only writes", async () => {
    const token = await sessionFor(keys, PERSON, ["coordenacao"]);
    const grants = openRoleTokens((await sessionDoc(token)) as never);
    world.revoked.add(grants.coordenacao.tokens["ipalpha:projects"]);
    expect((await call("POST", "/api/bedrooms", { name: "1", group: "girls" }, token)).status).toBe(401);
    expect(await sessionDoc(token)).toBeNull();
  });

  test("switch cannot activate a revoked destination token", async () => {
    world.memberships.push({ personId: PERSON, role: "saude", editionId: TEST_EDITION });
    const token = await sessionFor(keys, PERSON, ["equipe", "saude"]);
    const grants = openRoleTokens((await sessionDoc(token)) as never);
    world.revoked.add(grants.saude.tokens["ipalpha:projects"]);
    expect((await call("POST", "/api/auth/role", { role: "saude" }, token)).status).toBe(401);
    expect(await sessionDoc(token)).toBeNull();
  });

  test("core outage fails closed without discarding a valid session", async () => {
    const token = await sessionFor(keys, PERSON, ["coordenacao"]);
    core.setDown(true);
    expect((await call("GET", "/api/bedrooms", undefined, token)).status).toBe(503);
    expect(await sessionDoc(token)).not.toBeNull();
  });
});

test("coordenação keeps a history camp when the login edition is archived", async () => {
  const { ObjectId } = await import("mongodb");
  const { createCamp, activateCamp } = await import("../models/camps");
  const { activeCampId } = await import("../services/campContext");
  const original = activeCampId();
  const past = await createCamp({ label: "Synthetic past camp", year: 2024, createdByPersonId: PERSON });
  const current = await createCamp({ label: "Synthetic current camp", year: new Date().getFullYear(), createdByPersonId: PERSON });
  await activateCamp(current._id);
  world.editions = [
    { id: "edition-2024", year: 2024, current: false, status: "archived" },
    { id: TEST_EDITION, year: new Date().getFullYear(), current: true },
  ];
  try {
    const token = await sessionFor(keys, PERSON, ["coordenacao"]);
    const grants = openRoleTokens((await sessionDoc(token)) as never);
    expect(grants.coordenacao.editionId).toBe(TEST_EDITION);
    const switched = await call("POST", "/api/auth/camp", { campId: past._id }, token);
    expect(switched.status).toBe(200);
    const asked = core.callsTo("GET /projects/project-test-1/me/pending-kinds");
    expect(asked.every((c) => !c.query.has("editionId"))).toBe(true);
    const read = await call("GET", "/api/bedrooms", undefined, token);
    expect(read.status).toBe(200);
    expect(await sessionDoc(token)).not.toBeNull();
  } finally {
    await (await rawDb()).collection("camps").deleteMany({ _id: { $in: [new ObjectId(past._id), new ObjectId(current._id)] } });
    await activateCamp(original);
  }
});

test("a camp switch drops the previous camp's remembered role check", async () => {
  const { ObjectId } = await import("mongodb");
  const { createCamp, activateCamp } = await import("../models/camps");
  const { activeCampId } = await import("../services/campContext");
  const original = activeCampId();
  const past = await createCamp({ label: "Synthetic past camp", year: 2023, createdByPersonId: PERSON });
  try {
    const token = await sessionFor(keys, PERSON, ["coordenacao"]);
    expect((await call("GET", "/api/bedrooms", undefined, token)).status).toBe(200);
    const before = core.callsTo("GET /health-lists").length;
    expect((await call("POST", "/api/auth/camp", { campId: past._id }, token)).status).toBe(200);
    expect((await call("POST", "/api/auth/camp", { campId: original }, token)).status).toBe(200);
    expect((await call("GET", "/api/bedrooms", undefined, token)).status).toBe(200);
    expect(core.callsTo("GET /health-lists").length).toBeGreaterThan(before);
  } finally {
    await (await rawDb()).collection("camps").deleteOne({ _id: new ObjectId(past._id) });
    await activateCamp(original);
  }
});

test("a role check that passes then fails does not keep the previous success", async () => {
  const { validateSessionRole } = await import("../services/acting");
  const { IpalphaUnavailable } = await import("../services/ipalpha/coreClient");
  const token = await sessionFor(keys, PERSON, ["coordenacao"]);
  const session = (await sessionDoc(token)) as unknown as Session;
  await validateSessionRole(session); // remembered for this session
  core.on("GET /health-lists", () => json({ reason: "unavailable" }, 503));
  // a new check for the same session (another camp) drops the remembered success before calling core
  await expect(validateSessionRole({ ...session, campId: "another-camp" })).rejects.toBeInstanceOf(IpalphaUnavailable);
  const before = core.callsTo("GET /health-lists").length;
  // the earlier success is gone: the original camp is asked again and fails too
  await expect(validateSessionRole(session)).rejects.toBeInstanceOf(IpalphaUnavailable);
  expect(core.callsTo("GET /health-lists").length).toBe(before + 1);
  expect(await sessionDoc(token)).not.toBeNull();
});

test("a repeated camp read reuses the role check for about 15 s; a 401 still ends the session", async () => {
  const token = await sessionFor(keys, PERSON, ["coordenacao"]);
  expect((await call("GET", "/api/bedrooms", undefined, token)).status).toBe(200);
  const afterFirst = core.callsTo("GET /health-lists").length;
  expect((await call("GET", "/api/bedrooms", undefined, token)).status).toBe(200);
  expect(core.callsTo("GET /health-lists")).toHaveLength(afterFirst);
  const grants = openRoleTokens((await sessionDoc(token)) as never);
  world.revoked.add(grants.coordenacao.tokens["ipalpha:persons"]);
  const { clearValidationMemo } = await import("../services/sessionValidation");
  clearValidationMemo();
  expect((await call("GET", "/api/bedrooms", undefined, token)).status).toBe(401);
  expect(await sessionDoc(token)).toBeNull();
});

test("expired active role grant blocks camp operations while the local session is live", async () => {
  const { seal } = await import("../services/session");
  const token = await sessionFor(keys, PERSON, ["coordenacao"]);
  const doc = (await sessionDoc(token))!;
  const grants = openRoleTokens(doc as never);
  grants.coordenacao.expiresAt = Date.now() - 1;
  await (await rawDb()).collection("sessions").updateOne({ _id: doc._id }, { $set: { roleTokens: seal(JSON.stringify(grants)) } });
  expect((await call("GET", "/api/auth/me", undefined, token)).status).toBe(401);
  expect(await sessionDoc(token)).toBeNull();
});

test("websocket lifecycle rechecks live membership once the role memo expires", async () => {
  const { authorizedClientSession, addClient, removeClient } = await import("../services/realtime");
  const { clearValidationMemo } = await import("../services/sessionValidation");
  const token = await sessionFor(keys, PERSON, ["coordenacao"]);
  const doc = (await sessionDoc(token))!;
  const closed: number[] = [];
  const client = { sessionId: hashToken(token), personId: PERSON, campId: String(doc.campId), role: "admin" as const, coreRole: "coordenacao", ws: { readyState: 1, send() {}, close(code: number) { closed.push(code); } } as never };
  addClient(client);
  try {
    expect(await authorizedClientSession(client)).not.toBeNull();
    world.memberships = [];
    const asked = core.callsTo("GET /projects/project-test-1/memberships").length;
    // inside the 15 s window the remembered check still authorizes (ids only)
    expect(await authorizedClientSession(client)).not.toBeNull();
    expect(core.callsTo("GET /projects/project-test-1/memberships")).toHaveLength(asked);
    clearValidationMemo();
    expect(await authorizedClientSession(client)).toBeNull();
    expect(closed).toEqual([4401]);
    expect(await sessionDoc(token)).toBeNull();
  } finally { removeClient(client); }
});
