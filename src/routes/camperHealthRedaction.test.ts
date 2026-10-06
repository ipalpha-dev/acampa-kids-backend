import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";
import { EMPTY_STAFF, insertStaff } from "../models/staff";
import { insertEvent } from "../models/schedule";
import { updateSettings } from "../models/settings";
import { todayInSaoPaulo } from "../utils";

/**
 * Who sees which health fields of a kid (GET /:id, the list detail and the badge
 * lookup). Neurodivergence (a diagnosis) and the insurance + card (a document)
 * only for coordenação and saúde (and the responsável, for their own kid); a
 * room caretaker / helper, a check-in helper and a badge scan out of the room
 * get allergies, drug allergies, health issues, food restrictions and medicines only.
 */

const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ADMIN = "person-admin";
const SAUDE = "person-saude";
const CARETAKER = "person-caretaker";
const HELPER = "person-helper";
const CHECKIN = "person-checkin";
const OTHER_ROOM = "person-other-room";
const PARENT = "person-parent";
const KID = "person-kid";

const ROOM = "room-1";
const ROOM_2 = "room-2";

const HEALTH = {
  allergies: ["amendoim"],
  drugAllergies: ["dipirona"],
  healthIssues: ["asma"],
  neurodivergent: true,
  medications: [{ name: "Bombinha", dose: "2 jatos", times: ["08:00"], asNeeded: false, notes: "" }],
  foodRestrictions: "sem lactose",
  healthNotes: "usa óculos para ler",
  weightKg: 32,
  insurance: "Plano Exemplo",
  insuranceCard: "0000 1111",
};

const CARE_FIELDS = ["allergies", "drugAllergies", "foodRestrictions", "healthIssues", "medications"];
const WHOLE_FIELDS = ["allergies", "drugAllergies", "foodRestrictions", "healthIssues", "healthNotes", "insurance", "insuranceCard", "medications", "neurodivergent", "weightKg"];
const NEVER_FOR_CARE = ["neurodivergent", "insurance", "insuranceCard"];

const keysOf = (h: unknown) => Object.keys(h as Record<string, unknown>).sort();

function expectCare(h: unknown) {
  expect(keysOf(h)).toEqual(CARE_FIELDS);
  for (const f of NEVER_FOR_CARE) expect(h).not.toHaveProperty(f);
  expect(h).toEqual({ allergies: HEALTH.allergies, drugAllergies: HEALTH.drugAllergies, healthIssues: HEALTH.healthIssues, foodRestrictions: HEALTH.foodRestrictions, medications: HEALTH.medications });
}

function expectWhole(h: unknown) {
  expect(keysOf(h)).toEqual(WHOLE_FIELDS);
  expect(h).toEqual(HEALTH);
}

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  for (const [id, name] of [[ADMIN, "Coordenadora"], [SAUDE, "Enfermeira"], [CARETAKER, "Líder"], [HELPER, "Auxiliar"], [CHECKIN, "Check-in"], [OTHER_ROOM, "Líder Outro Quarto"], [PARENT, "Família Teste"], [KID, "Ana Pequena"]]) world.names.set(id, name);
  world.health.set(KID, HEALTH);
  world.memberships.push(
    { personId: ADMIN, role: "coordenacao" },
    { personId: SAUDE, role: "saude", editionId: TEST_EDITION },
    { personId: CARETAKER, role: "equipe", editionId: TEST_EDITION },
    { personId: HELPER, role: "equipe", editionId: TEST_EDITION },
    { personId: CHECKIN, role: "checkin", editionId: TEST_EDITION },
    { personId: OTHER_ROOM, role: "equipe", editionId: TEST_EDITION },
    { personId: PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: KID, role: "participante", editionId: TEST_EDITION, involved: [{ personId: PARENT, purpose: "responsible" }] },
  );
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  await insertStaff(CARETAKER, { ...EMPTY_STAFF, bedroom: ROOM, roomRole: "caretaker" });
  await insertStaff(HELPER, { ...EMPTY_STAFF, bedroom: ROOM, roomRole: "helper" });
  await insertStaff(OTHER_ROOM, { ...EMPTY_STAFF, bedroom: ROOM_2, roomRole: "caretaker" });
  await insertCamper(KID, { ...EMPTY_CAMPER, bedroom: ROOM, caretakerId: CARETAKER });
  // the camp is happening today: helpers reach their room's kids and the badge lookup works
  await insertEvent({ date: todayInSaoPaulo(), title: "Dia de acampamento", emoji: "🏕️", startTime: "00:00", endTime: "23:59", notes: "", roles: [], visibleToParents: true, assignments: [] });
});

/** GET /:id, the list narrowed by name (≤ 6 → detail) and the badge lookup, as `role`. */
async function readAll(personId: string, role: string) {
  const token = await sessionFor(keys, personId, [role]);
  const page = await call("GET", `/api/campers/${KID}`, undefined, token);
  const list = await call("GET", "/api/campers?q=Ana", undefined, token);
  const lookup = await call("GET", `/api/campers/lookup/${KID}`, undefined, token);
  expect(page.status).toBe(200);
  expect(list.status).toBe(200);
  expect(lookup.status).toBe(200);
  expect(list.body.items).toHaveLength(1);
  return { page: page.body.camper.health, list: list.body.items[0].health, lookup: lookup.body.camper.health, belonged: lookup.body.belonged, token };
}

describe("camper health per role", () => {
  test("caretaker (the kid under their care): allergies / drug allergies / health issues / food restrictions / medicines only — no neurodivergence, insurance or card", async () => {
    const r = await readAll(CARETAKER, "equipe");
    expect(r.belonged).toBe(true);
    for (const h of [r.page, r.list, r.lookup]) expectCare(h);
  });

  test("helper (same room, camp happening): the same care fields only — no neurodivergence, insurance or card", async () => {
    const r = await readAll(HELPER, "equipe");
    expect(r.belonged).toBe(true);
    for (const h of [r.page, r.list, r.lookup]) expectCare(h);
  });

  test("caretaker / helper may not filter the list by neurodivergence (it would reveal it); a care tag filter still works with care fields", async () => {
    for (const personId of [CARETAKER, HELPER]) {
      const token = await sessionFor(keys, personId, ["equipe"]);
      const neuro = await call("GET", "/api/campers?tag=neurodivergent", undefined, token);
      expect(neuro.status).toBe(403);
      expect(neuro.body.error.code).toBe("FORBIDDEN");
      const meds = await call("GET", "/api/campers?tag=medications", undefined, token);
      expect(meds.status).toBe(200);
      expect(meds.body.items).toHaveLength(1);
      expectCare(meds.body.items[0].health);
    }
  });

  test("check-in helper: care fields only", async () => {
    await updateSettings({ checkinWindow: { from: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000) } });
    const r = await readAll(CHECKIN, "checkin");
    for (const h of [r.page, r.list, r.lookup]) expectCare(h);
  });

  test("saúde: the whole block, neurodivergence and insurance + card included (and may filter by neurodivergence)", async () => {
    const r = await readAll(SAUDE, "saude");
    expect(r.belonged).toBe(true);
    for (const h of [r.page, r.list, r.lookup]) expectWhole(h);
    const neuro = await call("GET", "/api/campers?tag=neurodivergent", undefined, r.token);
    expect(neuro.status).toBe(200);
    expectWhole(neuro.body.items[0].health);
  });

  test("coordenação: the whole block, neurodivergence and insurance + card included", async () => {
    const r = await readAll(ADMIN, "coordenacao");
    expect(r.belonged).toBe(true);
    for (const h of [r.page, r.list, r.lookup]) expectWhole(h);
  });

  test("responsável: the whole block of their own kid (the family's own data)", async () => {
    const token = await sessionFor(keys, PARENT, ["responsavel"]);
    const page = await call("GET", `/api/campers/${KID}`, undefined, token);
    expect(page.status).toBe(200);
    expectWhole(page.body.camper.health);
  });

  test("badge scan out of scope (another room's caretaker): care fields only — never neurodivergence, insurance or card", async () => {
    const token = await sessionFor(keys, OTHER_ROOM, ["equipe"]);
    expect((await call("GET", `/api/campers/${KID}`, undefined, token)).status).toBe(404);
    const res = await call("GET", `/api/campers/lookup/${KID}`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.belonged).toBe(false);
    expect(res.body.camper.contactsHidden).toBe(true);
    expectCare(res.body.camper.health);
    expect(JSON.stringify(res.body)).not.toContain(HEALTH.insurance);
    expect(JSON.stringify(res.body)).not.toContain(HEALTH.insuranceCard);
  });
});
