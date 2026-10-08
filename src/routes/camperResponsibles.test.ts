import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";
import { EMPTY_STAFF, insertStaff } from "../models/staff";
import { updateSettings } from "../models/settings";

/** GET /api/campers/:id/responsibles — the 📞 button: kid name + responsáveis, never a health read. */

const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ADMIN = "person-admin";
const CARE = "person-caretaker";
const PARENT = "person-parent";
const OTHER_PARENT = "person-other-parent";
const KID_A = "person-kid-a";
const KID_B = "person-kid-b";

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  for (const [id, name] of [[ADMIN, "Coordenadora"], [CARE, "Líder"], [PARENT, "Família Teste"], [OTHER_PARENT, "Outra Família"], [KID_A, "Ana Pequena"], [KID_B, "Bruno Pequeno"]]) world.names.set(id, name);
  world.health.set(KID_A, { allergies: ["amendoim"], healthNotes: "asma" });
  world.memberships.push(
    { personId: ADMIN, role: "coordenacao" },
    { personId: CARE, role: "equipe", editionId: TEST_EDITION },
    { personId: PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: OTHER_PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: KID_A, role: "participante", editionId: TEST_EDITION, involved: [{ personId: PARENT, purpose: "responsible" }] },
    { personId: KID_B, role: "participante", editionId: TEST_EDITION, involved: [{ personId: OTHER_PARENT, purpose: "responsible" }] },
  );
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  await insertStaff(CARE, { ...EMPTY_STAFF, roomRole: "caretaker" });
  await insertCamper(KID_A, { ...EMPTY_CAMPER, caretakerId: CARE });
  await insertCamper(KID_B, { ...EMPTY_CAMPER, transportation: "bus-1" });
});

const healthReads = () => core.calls.filter((c) => c.path.includes("/data/medical") || c.path.includes("health") && c.path !== "/health-lists");

describe("GET /api/campers/:id/responsibles", () => {
  test("coordenação: kid name + responsáveis with live names, and no health read at all", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", `/api/campers/${KID_A}/responsibles`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ camper: { id: KID_A, name: "Ana Pequena" }, responsibles: [{ personId: PARENT, name: "Família Teste" }] });
    expect(core.calls.filter((c) => c.path.includes("/memberships")).length).toBeGreaterThan(0); // responsáveis read live from projects-api
    expect(healthReads()).toHaveLength(0);
  });

  test("a caretaker (visibility 'care') whose role seesPersonsOf participante + responsavel gets them, with their OWN token", async () => {
    const token = await sessionFor(keys, CARE, ["equipe"]);
    const res = await call("GET", `/api/campers/${KID_A}/responsibles`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ camper: { id: KID_A, name: "Ana Pequena" }, responsibles: [{ personId: PARENT, name: "Família Teste" }] });
    const lists = core.callsTo("GET /projects/project-test-1/memberships");
    expect(lists.map((c) => c.query.get("role")).sort()).toEqual(["participante", "responsavel"]);
    for (const c of lists) expect(JSON.parse(atob((c.headers.get("authorization") ?? "").split(".")[1]))).toMatchObject({ sub: CARE, projectRole: "equipe" });
    expect(healthReads()).toHaveLength(0);
  });

  test("a role core refuses the lists (no seesPersonsOf): fails closed and says so — never 'no responsável'", async () => {
    world.seesPersonsOf.equipe = ["participante"];
    const token = await sessionFor(keys, CARE, ["equipe"]);
    const res = await call("GET", `/api/campers/${KID_A}/responsibles`, undefined, token);
    expect(res.body).toEqual({ camper: { id: KID_A, name: "Ana Pequena" }, responsibles: [], responsiblesHidden: true });
    const page = await call("GET", `/api/campers/${KID_A}`, undefined, token);
    expect(page.body.camper).toMatchObject({ responsibles: [], responsiblesHidden: true });
  });

  test("a responsável whose role sees no lists still gets themselves for their own kid", async () => {
    world.memberships.find((m) => m.personId === KID_A)!.involved!.push({ personId: OTHER_PARENT, purpose: "responsible" });
    const token = await sessionFor(keys, PARENT, ["responsavel"]);
    const res = await call("GET", `/api/campers/${KID_A}/responsibles`, undefined, token);
    expect(res.body).toMatchObject({ responsibles: [{ personId: PARENT, name: "Família Teste" }], responsiblesHidden: true });
    world.seesPersonsOf.responsavel = ["participante", "responsavel"];
    const seen = await call("GET", `/api/campers/${KID_A}/responsibles`, undefined, token);
    expect(seen.body.responsibles.map((r: { personId: string }) => r.personId).sort()).toEqual([OTHER_PARENT, PARENT].sort());
    expect(seen.body.responsiblesHidden).toBeUndefined();
  });

  test("a responsável: their own kid only; another family's kid is 404 CAMPER_NOT_FOUND (same as GET /:id)", async () => {
    const token = await sessionFor(keys, PARENT, ["responsavel"]);
    const mine = await call("GET", `/api/campers/${KID_A}/responsibles`, undefined, token);
    expect(mine.status).toBe(200);
    expect(mine.body.camper).toEqual({ id: KID_A, name: "Ana Pequena" });
    const other = await call("GET", `/api/campers/${KID_B}/responsibles`, undefined, token);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe("CAMPER_NOT_FOUND");
    expect((await call("GET", `/api/campers/${KID_B}`, undefined, token)).status).toBe(404);
    expect(healthReads()).toHaveLength(0);
  });

  test("a caretaker asking for a kid out of their scope gets 404", async () => {
    const token = await sessionFor(keys, CARE, ["equipe"]);
    const res = await call("GET", `/api/campers/${KID_B}/responsibles`, undefined, token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CAMPER_NOT_FOUND");
  });

  test("in scope with 'name' visibility (bus helper at the kid's vehicle): the kid's name, responsibles: []", async () => {
    await updateSettings({ checkinWindow: { from: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000) }, busHelpers: { helpers: [{ personId: CARE, vehicleId: "bus-1" }] } });
    world.memberships.push({ personId: CARE, role: "checkin-onibus", editionId: TEST_EDITION });
    const token = await sessionFor(keys, CARE, ["checkin-onibus"]);
    const res = await call("GET", `/api/campers/${KID_B}/responsibles`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ camper: { id: KID_B, name: "Bruno Pequeno" }, responsibles: [] });
    expect(core.callsTo("GET /projects/project-test-1/memberships")).toHaveLength(0); // the responsáveis are never even looked up
  });

  test("unknown kid = 404; no session = 401", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("GET", "/api/campers/person-nobody/responsibles", undefined, token)).status).toBe(404);
    expect((await call("GET", `/api/campers/${KID_A}/responsibles`)).status).toBe(401);
  });
});
