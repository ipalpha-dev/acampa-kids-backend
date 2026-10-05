import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, json, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, TEST_PROJECT, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { createApp } from "../app";
import { config } from "../config";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";
import { EMPTY_STAFF, insertStaff } from "../models/staff";
import { getSettings, updateSettings } from "../models/settings";
import { isPrivilegedStaff, resolveScope, staffHasAccess } from "../services/scope";
import { clearMembersMemo, kidsOfResponsible } from "../services/members";
import { addClient, clientCount, removeClient, type RealtimeClient } from "../services/realtime";
import { findSessionByToken, hashToken } from "../services/session";
import { isBooted, markBooted, resetReadiness } from "../services/readiness";

const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ADMIN = "person-admin";
const PARENT = "person-parent";
const KID_A = "person-kid-a";
const KID_B = "person-kid-b";
const HELPER = "person-helper";
const OUTSIDER = "person-outsider";

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  for (const [id, name] of [[ADMIN, "Coordenadora"], [PARENT, "Família"], [KID_A, "Ana"], [KID_B, "Bruno"], [HELPER, "Ajudante"], [OUTSIDER, "Visitante"]]) world.names.set(id, name);
  world.health.set(KID_A, { allergies: ["amendoim"], healthNotes: "asma" });
  world.memberships.push(
    { personId: ADMIN, role: "coordenacao" },
    { personId: PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: KID_A, role: "participante", editionId: TEST_EDITION, involved: [{ personId: PARENT, purpose: "responsible" }] },
    { personId: KID_B, role: "participante", editionId: TEST_EDITION, involved: [{ personId: "someone-else", purpose: "responsible" }] },
    { personId: HELPER, role: "equipe", editionId: TEST_EDITION },
  );
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  await insertCamper(KID_A, { ...EMPTY_CAMPER });
  await insertCamper(KID_B, { ...EMPTY_CAMPER });
});

describe("unknown role keys behave exactly as equipe", () => {
  test("isPrivilegedStaff: only known helper flags (and coordenação) skip the staff window", async () => {
    const s = await getSettings();
    expect(isPrivilegedStaff(HELPER, "saude", s)).toBe(true);
    expect(isPrivilegedStaff(HELPER, "coordenacao", s)).toBe(true);
    expect(isPrivilegedStaff(HELPER, "equipe", s)).toBe(false);
    expect(isPrivilegedStaff(HELPER, "futuro-ajudante", s)).toBe(false);
    expect(isPrivilegedStaff(HELPER, "constructor", s)).toBe(false);
  });

  test("outside the staff window an unknown helper key gets NO_ACCESS like equipe", async () => {
    const past = { from: new Date(Date.now() - 3 * 86400_000), until: new Date(Date.now() - 2 * 86400_000) };
    await updateSettings({ staffAccessWindow: past } as never);
    await insertStaff(HELPER, { ...EMPTY_STAFF });
    const s = await getSettings();
    expect(staffHasAccess(HELPER, "futuro-ajudante", s)).toBe(false);
    expect(staffHasAccess(HELPER, "fotografia", s)).toBe(true);
    const scope = await resolveScope({ activeRole: "staff", coreRole: "futuro-ajudante", personId: HELPER });
    expect(scope.all).toBe(false);
    expect(scope.all === false && scope.staffId).toBeNull();
  });
});

describe("kidsOfResponsible checks `involved` itself", () => {
  test("a membership row returned by core WITHOUT the parent as responsible never opens the kid", async () => {
    // a core that ignores the involvedPersonId filter (bug / older version) answers every participante
    core.on(`GET /projects/${TEST_PROJECT}/memberships`, () =>
      json({ items: world.memberships.filter((m) => m.role === "participante").map((m) => ({ personId: m.personId, role: m.role, editionId: m.editionId, involved: m.involved ?? [] })), nextCursor: null }),
    );
    clearMembersMemo();
    expect(await kidsOfResponsible(PARENT)).toEqual([KID_A]);
  });
});

describe("POST {personId} checks the live edition membership first", () => {
  test("campers: a participante of the edition joins; anyone else is refused (409 NOT_IN_EDITION)", async () => {
    world.memberships.push({ personId: "person-kid-c", role: "participante", editionId: TEST_EDITION });
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const bad = await call("POST", "/api/campers", { personId: OUTSIDER }, token);
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("NOT_IN_EDITION");
    const ok = await call("POST", "/api/campers", { personId: "person-kid-c" }, token);
    expect(ok.status).toBe(201);
  });

  test("staff: someone serving in the edition joins; a participante / outsider is refused", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("POST", "/api/staff", { personId: OUTSIDER }, token)).status).toBe(409);
    world.memberships.push({ personId: "person-kid-c", role: "participante", editionId: TEST_EDITION });
    expect((await call("POST", "/api/staff", { personId: "person-kid-c" }, token)).body.error.code).toBe("NOT_IN_EDITION");
    expect((await call("POST", "/api/staff", { personId: HELPER }, token)).status).toBe(201);
  });
});

describe("♥ and counts without full medical reads (decisions 56, 69)", () => {
  test("a plain list asks core's health-flags; no medical block is read", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/campers", undefined, token);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.items.map((k: { id: string; hasHealth: boolean }) => [k.id, k.hasHealth]));
    expect(byId).toEqual({ [KID_A]: true, [KID_B]: false });
    expect(core.calls.filter((c) => c.path.includes("/data/medical"))).toHaveLength(0);
    expect(core.callsTo(`POST /projects/${TEST_PROJECT}/people/health-flags`)).toHaveLength(1);
  });

  test("health-counts sends the role (+ edition), never person ids", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/campers/health-counts?tags=allergies:amendoim", undefined, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 2, byTag: { amendoim: 1 } });
    const sent = core.callsTo(`POST /projects/${TEST_PROJECT}/people/count`)[0].json as Record<string, unknown>;
    expect(sent).toMatchObject({ role: "participante", editionId: TEST_EDITION });
    expect(sent.personIds).toBeUndefined();
  });
});

describe("wizard sample only in previews / dev (decision 71)", () => {
  test("production: GET says disabled, POST is 403 SAMPLE_DISABLED", async () => {
    const before = config.ipalphaEnv;
    try {
      config.ipalphaEnv = "";
      const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
      expect((await call("GET", "/api/wizard/sample", undefined, token)).body).toEqual({ enabled: false });
      const res = await call("POST", "/api/wizard/sample", {}, token);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("SAMPLE_DISABLED");
      config.ipalphaEnv = "preview";
      expect((await call("GET", "/api/wizard/sample", undefined, token)).body).toEqual({ enabled: true });
    } finally {
      config.ipalphaEnv = before;
    }
  });
});

describe("/live and /ready", () => {
  test("/live is always 200; /ready and /api/* wait for boot; /ready never checks core", async () => {
    const wasBooted = isBooted();
    try {
      resetReadiness(false);
      const app = createApp({ bootGate: true });
      expect((await app.request("/live")).status).toBe(200);
      const notYet = await app.request("/ready");
      expect(notYet.status).toBe(503);
      expect(await notYet.json()).toMatchObject({ ready: false, checks: { boot: "starting" } });
      expect((await app.request("/api/camps/active")).status).toBe(503);
      markBooted();
      core.setDown(true); // a peer being down never makes us unready
      const ok = await app.request("/ready");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ready: true, checks: { boot: "ok", mongo: "ok" } });
    } finally {
      core.setDown(false);
      resetReadiness(wasBooted);
    }
  });
});

describe("realtime sockets follow the session", () => {
  function fakeSocket() {
    const sent: string[] = [];
    const closed: number[] = [];
    return { sent, closed, ws: { readyState: 1, send: (s: string) => sent.push(s), close: (code: number) => closed.push(code) } };
  }

  test("logout closes the session's sockets with SESSION_ENDED (4401)", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const sock = fakeSocket();
    const client: RealtimeClient = { ws: sock.ws as never, role: "admin", coreRole: "coordenacao", personId: ADMIN, sessionId: hashToken(token), campId: (await findSessionByToken(token))!.campId };
    addClient(client);
    expect((await call("POST", "/api/auth/logout", {}, token)).status).toBe(200);
    expect(sock.closed).toEqual([4401]);
    expect(JSON.parse(sock.sent.at(-1)!)).toMatchObject({ type: "error", code: "SESSION_ENDED" });
    removeClient(client);
  });

  test("a core 401 (SESSION_ENDED) closes the sockets too", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const sock = fakeSocket();
    const client: RealtimeClient = { ws: sock.ws as never, role: "admin", coreRole: "coordenacao", personId: ADMIN, sessionId: hashToken(token), campId: (await findSessionByToken(token))!.campId };
    addClient(client);
    core.on(`POST /projects/${TEST_PROJECT}/people/health-flags`, () => json({ reason: "invalidToken" }, 401));
    const res = await call("GET", "/api/campers", undefined, token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_ENDED");
    expect(sock.closed).toEqual([4401]);
    removeClient(client);
  });

  test("a role switch re-keys the socket and sends a fresh snapshot of the NEW scope", async () => {
    const token = await sessionFor(keys, PARENT, ["responsavel", "equipe"], "responsavel");
    world.memberships.push({ personId: PARENT, role: "equipe", editionId: TEST_EDITION });
    await insertStaff(PARENT, { ...EMPTY_STAFF });
    const sock = fakeSocket();
    const client: RealtimeClient = { ws: sock.ws as never, role: "parent", coreRole: "responsavel", personId: PARENT, sessionId: hashToken(token), campId: (await findSessionByToken(token))!.campId };
    addClient(client);
    const before = clientCount();
    const res = await call("POST", "/api/auth/role", { role: "equipe" }, token);
    expect(res.status).toBe(200);
    expect(client.coreRole).toBe("equipe");
    expect(client.role).toBe("staff");
    expect(clientCount()).toBe(before);
    expect(JSON.parse(sock.sent.at(-1)!).type).toBe("snapshot");
    expect(sock.closed).toEqual([]);
    removeClient(client);
  });

  test("/me answers the slid expiry (the browser stores only the opaque token)", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/auth/me", undefined, token);
    expect(res.status).toBe(200);
    expect(typeof res.body.tokenExpiresAt).toBe("string");
    expect(new Date(res.body.tokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
