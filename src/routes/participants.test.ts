import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";
import { EMPTY_STAFF, insertStaff } from "../models/staff";
import { insertBedroom } from "../models/bedrooms";
import { updateSettings } from "../models/settings";
import { enqueueHealth } from "../models/healthQueue";
import { loadCollections } from "../services/snapshot";
import { resolveScope } from "../services/scope";
import { flushNotifications } from "../services/notify";
import { TEMPLATE_DEFAULTS } from "../messages/templates";

const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ADMIN = "person-admin";
const CARE = "person-caretaker";
const MEDIC = "person-medic";
const PARENT = "person-parent";
const KID_A = "person-kid-a";
const KID_B = "person-kid-b";
let roomId: string;

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  for (const [id, name] of [[ADMIN, "Coordenadora Teste"], [CARE, "Líder Teste"], [MEDIC, "Saúde Teste"], [PARENT, "Família Teste"], [KID_A, "Ana Pequena"], [KID_B, "Bruno Pequeno"]]) world.names.set(id, name);
  world.health.set(KID_A, { allergies: ["amendoim"], drugAllergies: [], healthIssues: [], neurodivergent: false, medications: [{ name: "Ritalina", dose: "10mg", times: ["08:00"], asNeeded: false, notes: "" }], foodRestrictions: "", healthNotes: "asma leve", weightKg: 30, insurance: "", insuranceCard: "" });
  world.memberships.push(
    { personId: ADMIN, role: "coordenacao" },
    { personId: CARE, role: "equipe", editionId: TEST_EDITION },
    { personId: MEDIC, role: "saude", editionId: TEST_EDITION },
    { personId: PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: KID_A, role: "participante", editionId: TEST_EDITION, involved: [{ personId: PARENT, purpose: "responsible" }] },
    { personId: KID_B, role: "participante", editionId: TEST_EDITION, involved: [{ personId: "someone-else", purpose: "responsible" }] },
  );
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  roomId = (await insertBedroom({ name: "101", group: "girls", bunkBeds: 2, singleBeds: 1, notes: "" }))._id;
  await insertStaff(CARE, { ...EMPTY_STAFF, bedroom: roomId, roomRole: "caretaker", sex: "F" });
  await insertCamper(KID_A, { ...EMPTY_CAMPER, bedroom: roomId, caretakerId: CARE, sex: "F", generalNotes: "gosta de pintar" });
  await insertCamper(KID_B, { ...EMPTY_CAMPER });
});

describe("campers: camp ops + names live, health only with the acting role token", () => {
  test("coordenação gets one page with names and the neutral ♥, never health details in a plain list", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/campers?limit=1", undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: KID_A, name: "Ana Pequena", hasHealth: true });
    expect(res.body.items[0].health).toBeUndefined();
    const next = await call("GET", `/api/campers?limit=1&cursor=${res.body.nextCursor}`, undefined, token);
    expect(next.body.items[0]).toMatchObject({ id: KID_B, name: "Bruno Pequeno", hasHealth: false });
    expect(next.body.nextCursor).toBeNull();
  });

  test("a name filter narrowed to ≤ 6 kids shows the health tags (decision 31)", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/campers?q=ana", undefined, token);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].health).toMatchObject({ allergies: ["amendoim"], healthNotes: "asma leve" });
  });

  test("a health-tag filter returns only the matching kids, with details; the chips come from the count endpoint", async () => {
    const token = await sessionFor(keys, MEDIC, ["saude"]);
    const res = await call("GET", "/api/campers?tag=allergies:amendoim", undefined, token);
    expect(res.body.items.map((k: { id: string }) => k.id)).toEqual([KID_A]);
    expect(res.body.items[0].health.allergies).toEqual(["amendoim"]);
    const counts = await call("GET", "/api/campers/health-counts?tags=allergies:amendoim", undefined, token);
    expect(counts.body).toEqual({ total: 2, byTag: { amendoim: 1 } });
  });

  test("a caretaker (equipe) only sees the kid under their care; a responsável only their own kid", async () => {
    const care = await sessionFor(keys, CARE, ["equipe"]);
    const res = await call("GET", "/api/campers", undefined, care);
    expect(res.body.items.map((k: { id: string }) => k.id)).toEqual([KID_A]);
    expect(res.body.items[0]).toMatchObject({ contactsHidden: true, qrToken: "" });

    const parent = await sessionFor(keys, PARENT, ["responsavel"]);
    const mine = await call("GET", "/api/campers", undefined, parent);
    expect(mine.body.items.map((k: { id: string }) => k.id)).toEqual([KID_A]);
    expect((await call("GET", `/api/campers/${KID_B}`, undefined, parent)).status).toBe(404);
    const page = await call("GET", `/api/campers/${KID_A}`, undefined, parent);
    expect(page.body.camper).toMatchObject({ name: "Ana Pequena", health: { healthNotes: "asma leve" }, responsibles: [{ personId: PARENT, name: "Família Teste" }] });
  });

  test("the medical team edits health in persons-api; the change log keeps field names only", async () => {
    const token = await sessionFor(keys, MEDIC, ["saude"]);
    const res = await call("PUT", `/api/campers/${KID_A}/health`, { healthNotes: "asma moderada", weightKg: 31 }, token);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(world.health.get(KID_A)).toMatchObject({ healthNotes: "asma moderada", weightKg: 31, allergies: ["amendoim"] });
    const log = await (await rawDb()).collection("camperChangeLog").findOne({ personId: KID_A });
    expect(log).toMatchObject({ byPersonId: MEDIC, byRole: "saude", medical: true, fields: ["healthNotes", "weightKg"] });
    expect(JSON.stringify(log)).not.toContain("asma");
  });

  test("a responsável edits their kid's notes (Acampa) and health (persons-api); the caretaker is told by template", async () => {
    await updateSettings({ notifications: { ...(await import("../models/settings")).DEFAULT_SETTINGS.notifications, parentEdits: true } });
    const token = await sessionFor(keys, PARENT, ["responsavel"]);
    const res = await call("PUT", `/api/campers/${KID_A}/parent`, { generalNotes: "dorme cedo", foodRestrictions: "sem lactose" }, token);
    expect(res.status).toBe(200);
    expect(world.health.get(KID_A)).toMatchObject({ foodRestrictions: "sem lactose" });
    const row = await (await rawDb()).collection("participants").findOne({ personId: KID_A });
    expect(row).toMatchObject({ generalNotes: "dorme cedo" });
    expect(JSON.stringify(row)).not.toContain("lactose");
    await new Promise((r) => setTimeout(r, 30)); // the edit notifies in the background
    await flushNotifications();
    const sent = world.messages.find((m) => m.slug === "acampa-parent-edit-medical");
    expect(sent?.recipients.map((r) => r.personId).sort()).toEqual([ADMIN, CARE, MEDIC].sort());
    expect(sent?.recipients[0].variables).toMatchObject({ kid: "Ana" });
  });

  test("bus check-in: the responsáveis are told by person id (template), never a phone", async () => {
    await updateSettings({ notifications: { ...(await import("../models/settings")).DEFAULT_SETTINGS.notifications, busCheckin: true } });
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("POST", `/api/campers/${KID_A}/checkin`, {}, token)).status).toBe(200);
    expect((await call("POST", `/api/campers/${KID_A}/checkin/bus`, {}, token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const sent = world.messages.find((m) => m.slug === "acampa-bus-boarded");
    expect(sent?.recipients).toEqual([{ personId: PARENT, variables: { kid: "Ana", name: "Família" } }]);
    const log = await (await rawDb()).collection("checkinLog").find({ personId: KID_A }).toArray();
    expect(log.map((l) => l.kind)).toEqual(["church", "bus"]);
    expect(log[0]).toMatchObject({ byPersonId: ADMIN, byRole: "coordenacao" });
  });

  test("register: a new kid + responsável through core (registration, memberships, health) and a camp-ops row", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("POST", "/api/campers/register", { name: "carla nova", birthDate: "2016-03-02", responsible: { name: "dora nova", phone: "(11) 98888-1111" }, health: { healthNotes: "nenhuma" }, generalNotes: "primeira vez" }, token);
    expect(res.status).toBe(201);
    const kidId = res.body.camper.id;
    expect(res.body.camper).toMatchObject({ name: "Carla Nova", generalNotes: "primeira vez" });
    const reg = core.callsTo("POST /registrations")[0].json as Record<string, any>;
    expect(reg).toMatchObject({ projectId: "project-test-1", role: "participante", responsible: { name: "Dora Nova", phone: "+5511988881111" }, children: [{ name: "Carla Nova", birthDate: "2016-03-02" }] });
    expect(world.memberships).toContainEqual(expect.objectContaining({ personId: kidId, role: "participante", editionId: TEST_EDITION, involved: [expect.objectContaining({ personId: res.body.responsible.personId })] }));
    expect(world.memberships).toContainEqual(expect.objectContaining({ personId: res.body.responsible.personId, role: "responsavel", editionId: TEST_EDITION }));
    expect(world.health.get(kidId)).toMatchObject({ healthNotes: "nenhuma" });
    const row = await (await rawDb()).collection("participants").findOne({ personId: kidId });
    expect(JSON.stringify(row)).not.toContain("Carla");
    expect(JSON.stringify(row)).not.toContain("98888");
  });

  test("only the coordenação registers people", async () => {
    world.memberships.push({ personId: "person-org", role: "organizacao", editionId: TEST_EDITION });
    const token = await sessionFor(keys, "person-org", ["organizacao"]);
    const res = await call("POST", "/api/campers/register", { name: "X Y", birthDate: "2016-03-02", responsible: { name: "Z", phone: "11988881111" } }, token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("COORDINATION_REQUIRED");
  });

  test("delete removes the camp-ops row and the participante membership", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("DELETE", `/api/campers/${KID_B}`, undefined, token);
    expect(res.body).toEqual({ success: true, membershipRemoved: true });
    expect(world.memberships.some((m) => m.personId === KID_B)).toBe(false);
  });
});

describe("realtime snapshot carries no person data", () => {
  test("campers / staff are camp-ops records keyed by person id", async () => {
    const data = await loadCollections({ activeRole: "admin", coreRole: "coordenacao", personId: ADMIN });
    const text = JSON.stringify(data);
    expect((data.campers as unknown[]).length).toBe(2);
    for (const word of ["Ana Pequena", "asma", "amendoim", "Ritalina", "Família"]) expect(text).not.toContain(word);
    expect(core.callsTo(`POST /projects/project-test-1/people/names`)).toHaveLength(0);
  });
});

describe("§10 role keys → scope", () => {
  test("checkin only inside the check-in window; checkin-onibus gets its vehicle from settings", async () => {
    const closed = await resolveScope({ activeRole: "staff", coreRole: "checkin", personId: CARE });
    expect(closed.all ? null : closed.checkinHelper).toBe(false);
    await updateSettings({ checkinWindow: { from: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000) }, busHelpers: { helpers: [{ personId: CARE, vehicleId: "bus-1" }] } });
    const open = await resolveScope({ activeRole: "staff", coreRole: "checkin", personId: CARE });
    expect(open.all ? null : open.checkinHelper).toBe(true);
    const bus = await resolveScope({ activeRole: "staff", coreRole: "checkin-onibus", personId: CARE });
    expect(bus.all ? null : bus.busHelperVehicle).toBe("bus-1");
  });

  test("organizacao = the coordenação's data minus its own settings; saude = medical; unknown helper keys act as equipe", async () => {
    expect(await resolveScope({ activeRole: "staff", coreRole: "organizacao", personId: "x" })).toEqual({ all: true, admin: false });
    const medic = await resolveScope({ activeRole: "staff", coreRole: "saude", personId: MEDIC });
    expect(medic.all ? null : medic.medical).toBe(true);
    const future = await resolveScope({ activeRole: "staff", coreRole: "cozinha", personId: CARE });
    expect(future.all ? null : future.staffId).toBe(CARE);
    expect(await resolveScope({ activeRole: "staff", coreRole: "cozinha", personId: "not-on-team" })).toMatchObject({ all: false, staffId: null });
  });
});

describe("/api/people", () => {
  test("names: a team member only learns the names of people in their scope", async () => {
    const care = await sessionFor(keys, CARE, ["equipe"]);
    const res = await call("POST", "/api/people/names", { personIds: [KID_A, KID_B, ADMIN] }, care);
    expect(res.body.items).toEqual([{ personId: KID_A, name: "Ana Pequena", nickname: null }]);
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("POST", "/api/people/names", { personIds: [KID_A, KID_B] }, admin)).body.items).toHaveLength(2);
    expect((await call("POST", "/api/people/names", { personIds: Array.from({ length: 201 }, (_, i) => `p${i}`) }, admin)).status).toBe(400);
  });

  test("health queue: AI results are written with the coordenação token, merged into core lists, then dropped", async () => {
    world.health.set(KID_B, { allergies: [], drugAllergies: [], healthIssues: [], neurodivergent: false, medications: [], foodRestrictions: "", healthNotes: "usa óculos", weightKg: null, insurance: "", insuranceCard: "" });
    await enqueueHealth({ personId: KID_B, kind: "camper", importId: null, patch: { healthNotes: "bronquite", allergies: ["amendoim"] } });
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("GET", "/api/people/health-queue", undefined, admin)).body.pending).toBe(1);
    const res = await call("POST", "/api/people/health-queue/flush", {}, admin);
    expect(res.body).toMatchObject({ written: 1, pending: 0 });
    expect(world.health.get(KID_B)).toMatchObject({ healthNotes: "usa óculos bronquite", allergies: ["amendoim"] });
    expect(await (await rawDb()).collection("healthQueue").countDocuments({})).toBe(0);
  });
});

describe("message templates (settings → projects:templates)", () => {
  test("seed creates every catalog template; the list merges live + defaults", async () => {
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const seeded = await call("POST", "/api/settings/message-templates/seed", {}, admin);
    expect(seeded.body).toEqual({ created: TEMPLATE_DEFAULTS.length, total: TEMPLATE_DEFAULTS.length });
    const list = await call("GET", "/api/settings/message-templates", undefined, admin);
    expect(list.body.templates.every((t: { live: boolean }) => t.live)).toBe(true);
    expect(list.body.templates.find((t: { slug: string }) => t.slug === "acampa-bus-boarded")).toMatchObject({ channel: "sms", variables: ["name", "kid"], customized: false });
  });

  test("an edit is validated with core's rules before it is sent", async () => {
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const bad = await call("PATCH", "/api/settings/message-templates/acampa-bus-boarded", { body: { "pt-BR": "Oi {name}, {cpf}" } }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("TEMPLATE_INVALID");
    const ok = await call("PATCH", "/api/settings/message-templates/acampa-bus-boarded", { body: { "pt-BR": "Oi {name}, {kid} embarcou!" } }, admin);
    expect(ok.status).toBe(200);
    expect(ok.body.template).toMatchObject({ live: true, customized: true });
    const reset = await call("POST", "/api/settings/message-templates/acampa-bus-boarded/reset", {}, admin);
    expect(reset.body.template.customized).toBe(false);
  });

  test("only the coordenação edits templates", async () => {
    const care = await sessionFor(keys, CARE, ["equipe"]);
    expect((await call("GET", "/api/settings/message-templates", undefined, care)).status).toBe(403);
  });
});
