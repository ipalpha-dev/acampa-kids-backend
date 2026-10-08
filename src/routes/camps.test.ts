import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, TEST_PROJECT, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { activateCamp, findCamp, getActiveCamp } from "../models/camps";
import { refreshActiveCamp } from "../services/campContext";

/** Camps map to an edition created in Oikos — Acampa never creates or rolls one over. */
const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;
let originalCamp: string;

const ADMIN = "person-admin";
const YEAR = new Date().getFullYear();

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  originalCamp = (await getActiveCamp())!._id;
  core = createFakeCore();
  world = emptyWorld();
  world.memberships.push({ personId: ADMIN, role: "coordenacao" });
  world.editions.push({ id: "edition-next", year: YEAR + 1, current: false });
  installFakeCore(core, world);
  enableIpalpha(core, keys);
});

afterEach(async () => {
  await activateCamp(originalCamp);
  await refreshActiveCamp();
  await (await rawDb()).collection("camps").deleteMany({ year: { $in: [YEAR + 1, YEAR + 2] } });
});

const rollovers = () => core.calls.filter((c) => c.method !== "GET" && c.path.includes("/editions"));

describe("camps ↔ IPAlpha editions", () => {
  test("create: the camp keeps the Oikos edition of its year (read with the coordenação token), nothing is created in core", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("POST", "/api/camps", { label: "Acampa Kids próximo", year: YEAR + 1 }, token);
    expect(res.status).toBe(201);
    expect((await findCamp(res.body.camp.id))?.editionId).toBe("edition-next");
    const read = core.callsTo(`GET /projects/${TEST_PROJECT}/editions`);
    expect(JSON.parse(atob((read[0].headers.get("authorization") ?? "").split(".")[1]))).toMatchObject({ sub: ADMIN, projectRole: "coordenacao" });
    expect(rollovers()).toEqual([]);
  });

  test("create: no edition of that year yet → 409 EDITION_MISSING (gentle message) and no camp", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("POST", "/api/camps", { label: "Acampa Kids depois", year: YEAR + 2 }, token);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "EDITION_MISSING", year: YEAR + 2 });
    expect(res.body.error.message).toContain("Oikos");
    expect(await (await rawDb()).collection("camps").countDocuments({ year: YEAR + 2 })).toBe(0);
    expect((await getActiveCamp())!._id).toBe(originalCamp);
  });

  test("activate / change the year: validated against the editions first; a missing edition changes nothing", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const created = (await call("POST", "/api/camps", { label: "Acampa Kids próximo", year: YEAR + 1 }, token)).body.camp.id as string;
    await activateCamp(originalCamp);
    await refreshActiveCamp();
    const moved = await call("PUT", `/api/camps/${created}`, { year: YEAR + 2, active: true }, token);
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe("EDITION_MISSING");
    expect(await findCamp(created)).toMatchObject({ year: YEAR + 1, active: false, editionId: "edition-next" });
    const back = await call("PUT", `/api/camps/${originalCamp}`, { active: true }, token);
    expect(back.status).toBe(200);
    expect((await findCamp(originalCamp))?.editionId).toBe(TEST_EDITION);
    expect(rollovers()).toEqual([]);
  });
});
