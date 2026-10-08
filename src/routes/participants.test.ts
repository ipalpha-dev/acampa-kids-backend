import { createApp } from "../app";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";
import { EMPTY_STAFF, insertStaff } from "../models/staff";
import { insertBedroom } from "../models/bedrooms";
import { updateSettings } from "../models/settings";
import { loadCollections } from "../services/snapshot";
import { resolveScope } from "../services/scope";
import { flushNotifications } from "../services/notify";

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
  world.sex.set(KID_A, "female");
  world.sex.set(KID_B, "male");
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
  await insertStaff(CARE, { ...EMPTY_STAFF, bedroom: roomId, roomRole: "caretaker" });
  await insertCamper(KID_A, { ...EMPTY_CAMPER, bedroom: roomId, caretakerId: CARE, generalNotes: "gosta de pintar" });
  await insertCamper(KID_B, { ...EMPTY_CAMPER });
});

describe("campers: camp ops + names live, health only with the acting role token", () => {
  test("coordenação gets one page with names and the neutral ♥, never health details in a plain list", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/campers?limit=1", undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: KID_A, name: "Ana Pequena", sex: "F", hasHealth: true });
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
    const sent = world.messages.filter((m) => m.slug === "acampa-parent-edit-medical");
    // the caretaker by person id; saúde + coordenação as a role audience (a family cannot list them)
    expect(sent.flatMap((m) => m.recipients.map((r) => r.personId)).sort()).toEqual([ADMIN, CARE, MEDIC].sort());
    expect(sent.find((m) => m.audience)?.audience).toEqual({ roles: ["saude", "coordenacao"], editionId: TEST_EDITION });
    for (const m of sent) expect(m.recipients[0].variables).toMatchObject({ kid: "Ana" });
  });

  test("a responsável reads / edits their kid's health with THEIR responsavel role token (core's onlyInvolved rule, §19)", async () => {
    const token = await sessionFor(keys, PARENT, ["responsavel"]);
    const role = (call: { headers: Headers }) => JSON.parse(atob(call.headers.get("authorization")!.split(".")[1])).projectRole;
    const page = await call("GET", `/api/campers/${KID_A}`, undefined, token);
    expect(page.body.camper.health).toMatchObject({ healthNotes: "asma leve" });
    expect(page.body.camper.healthForbidden).toBeUndefined();
    expect(core.callsTo(`GET /persons/${KID_A}/data/medical`).map(role)).toEqual(["responsavel"]);
    expect((await call("PUT", `/api/campers/${KID_A}/parent`, { foodRestrictions: "sem glúten" }, token)).status).toBe(200);
    expect(core.callsTo(`PATCH /persons/${KID_A}/data/medical`).map(role)).toEqual(["responsavel"]);
    // never the app client / a system token for a family's health
    expect(core.calls.filter((c) => c.path.startsWith("/persons/") && (c.headers.get("authorization") ?? "").startsWith("Bearer system:"))).toEqual([]);
  });

  test("core refusing a responsável's health (403) is told apart from 'nothing informed' and nothing is written", async () => {
    world.medicalForbidden.add(KID_A);
    const token = await sessionFor(keys, PARENT, ["responsavel"]);
    const page = await call("GET", `/api/campers/${KID_A}`, undefined, token);
    expect(page.status).toBe(200);
    expect(page.body.camper).toMatchObject({ health: null, healthForbidden: true, name: "Ana Pequena" });
    const res = await call("PUT", `/api/campers/${KID_A}/parent`, { foodRestrictions: "sem glúten", generalNotes: "dorme cedo" }, token);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "CORE_FORBIDDEN", reason: "medicalForbidden" });
    expect(core.callsTo(`PATCH /persons/${KID_A}/data/medical`)).toHaveLength(0);
    expect(world.health.get(KID_A)).toMatchObject({ healthNotes: "asma leve", allergies: ["amendoim"] });
    expect(await (await rawDb()).collection("participants").findOne({ personId: KID_A })).toMatchObject({ generalNotes: "gosta de pintar" });
  });

  test("prescriptions carry each kid's drug allergies (+ allergies / conditions), read live with the acting saúde token", async () => {
    world.health.set(KID_A, { ...world.health.get(KID_A)!, drugAllergies: ["dipirona"], healthIssues: ["asma"] });
    const token = await sessionFor(keys, MEDIC, ["saude"]);
    const res = await call("GET", "/api/medications/prescriptions", undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ personId: KID_A, name: "Ana Pequena", medications: [expect.objectContaining({ name: "Ritalina" })], drugAllergies: ["dipirona"], allergies: ["amendoim"], healthIssues: ["asma"] }]);
    const read = core.callsTo("GET /projects/project-test-1/people");
    expect(JSON.parse(atob(read[0].headers.get("authorization")!.split(".")[1]))).toMatchObject({ projectRole: "saude" });
    expect(read[0].query.get("kinds") ?? read[0].query.getAll("kind").join(",")).toContain("medical");
    // nothing about health rests in Acampa
    const db = await rawDb();
    for (const name of ["participants", "medicationDoses", "camperChangeLog"]) expect(JSON.stringify(await db.collection(name).find({}).toArray())).not.toContain("dipirona");
  });

  test("bus check-in: the responsáveis are told by person id (template), never a phone", async () => {
    await updateSettings({ notifications: { ...(await import("../models/settings")).DEFAULT_SETTINGS.notifications, busCheckin: true } });
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("POST", `/api/campers/${KID_A}/checkin`, {}, token)).status).toBe(200);
    expect((await call("POST", `/api/campers/${KID_A}/checkin/bus`, {}, token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const sent = world.messages.find((m) => m.slug === "acampa-bus-boarded");
    expect(sent?.recipients).toEqual([{ personId: PARENT, variables: { kid: "Ana" } }]);
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
    // health NEVER travels in the registration (core would replace an existing kid's block): written after it
    expect(reg.children?.[0]?.data?.medical).toBeUndefined();
    expect(core.callsTo(`PATCH /persons/${kidId}/data/medical`)).toHaveLength(1);
    // a kid core just created has nothing to keep: no read before the write
    expect(core.callsTo(`GET /persons/${kidId}/data/medical`)).toHaveLength(0);
    expect(res.body.medical).toBe("written");
    const row = await (await rawDb()).collection("participants").findOne({ personId: kidId });
    expect(JSON.stringify(row)).not.toContain("Carla");
    expect(JSON.stringify(row)).not.toContain("98888");
  });

  test("register sends core what it takes: sex, homeChurch and data {school, emergencyContact}; health merged after", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call(
      "POST",
      "/api/campers/register",
      {
        name: "lia nova", birthDate: "2017-05-06", responsible: { name: "rui novo", phone: "11977771111" }, sex: "F", homeChurch: " IP Alphaville ",
        school: { name: "Escola Sol", grade: "3º ano" }, emergencyContact: { name: "Vó Lu", phone: "(11) 96666-5555", relation: "avó" }, health: { allergies: ["amendoim"] },
      },
      token,
    );
    expect(res.status).toBe(201);
    const child = (core.callsTo("POST /registrations")[0].json as Record<string, any>).children[0];
    expect(child).toMatchObject({ name: "Lia Nova", sex: "female", homeChurch: "IP Alphaville", data: { school: { name: "Escola Sol", grade: "3º ano" }, emergencyContact: { name: "Vó Lu", phone: "+5511966665555", relation: "avó" } } });
    expect(child.data.medical).toBeUndefined();
    expect(world.health.get(res.body.camper.id)).toMatchObject({ allergies: ["amendoim"] });
    expect(world.sex.get(res.body.camper.id)).toBe("female");
    // nothing that was not said is sent (sex is never guessed)
    await call("POST", "/api/campers/register", { name: "teo novo", birthDate: "2017-05-07", responsible: { name: "rui novo", phone: "11977771111" } }, token);
    const plain = (core.callsTo("POST /registrations")[1].json as Record<string, any>).children[0];
    expect(plain).toEqual({ name: "Teo Novo", birthDate: "2017-05-07" });
  });

  test("register of a kid core already knows NEVER erases their health: lists unioned, texts kept, read with the coordenação token", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    // the family registered Mia last year: core knows the responsável's phone and the kid (linked)
    world.names.set("person-mia", "Mia Antiga");
    world.births.set("person-mia", "2016-01-10");
    world.names.set("person-rosa", "Rosa Antiga");
    world.phones.set("+5511933332222", "person-rosa");
    world.links.push({ subjectId: "person-mia", agentId: "person-rosa" });
    world.health.set("person-mia", { allergies: ["amendoim"], drugAllergies: ["dipirona"], healthIssues: [], neurodivergent: true, medications: [{ name: "Ritalina", dose: "10mg", times: ["08:00"], asNeeded: false, notes: "" }], foodRestrictions: "sem lactose", healthNotes: "asma leve", weightKg: 28, insurance: "Unimed", insuranceCard: "123" });
    const res = await call("POST", "/api/campers/register", { name: "mia antiga", birthDate: "2016-01-10", responsible: { name: "rosa antiga", phone: "(11) 93333-2222" }, health: { allergies: ["amendoim"], healthNotes: "usa óculos", insurance: "" } }, token);
    expect(res.status).toBe(201);
    expect(res.body.camper.id).toBe("person-mia");
    expect(res.body.medical).toBe("written");
    const h = world.health.get("person-mia")!;
    expect(h).toMatchObject({ allergies: ["amendoim"], drugAllergies: ["dipirona"], neurodivergent: true, foodRestrictions: "sem lactose", weightKg: 28, insurance: "Unimed", insuranceCard: "123" });
    expect(h.medications).toHaveLength(1);
    expect(h.healthNotes).toBe("asma leve usa óculos");
    // read first, with the acting coordenação token (logged by core), then one merged write
    const read = core.callsTo("GET /persons/person-mia/data/medical");
    expect(read).toHaveLength(1);
    expect(JSON.parse(atob(read[0].headers.get("authorization")!.split(".")[1]))).toMatchObject({ projectRole: "coordenacao" });
  });

  test("register of a kid whose health core will not let the coordenação read writes nothing over it", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    world.names.set("person-mia", "Mia Antiga");
    world.births.set("person-mia", "2016-01-10");
    world.phones.set("+5511933332222", "person-rosa");
    world.links.push({ subjectId: "person-mia", agentId: "person-rosa" });
    world.health.set("person-mia", { allergies: ["amendoim"], healthNotes: "asma leve" });
    world.medicalForbidden.add("person-mia");
    const res = await call("POST", "/api/campers/register", { name: "mia antiga", birthDate: "2016-01-10", responsible: { name: "rosa", phone: "11933332222" }, health: { healthNotes: "outra coisa" } }, token);
    expect(res.status).toBe(201);
    expect(res.body.medical).toBe("refused");
    expect(core.callsTo("PATCH /persons/person-mia/data/medical")).toHaveLength(0);
    expect(world.health.get("person-mia")).toEqual({ allergies: ["amendoim"], healthNotes: "asma leve" });
  });

  test("register refuses an unknown sex or an unreadable emergency contact before calling core", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const base = { name: "lia nova", birthDate: "2017-05-06", responsible: { name: "rui novo", phone: "11977771111" } };
    expect((await call("POST", "/api/campers/register", { ...base, sex: "X" }, token)).body.error.code).toBe("SEX_INVALID");
    expect((await call("POST", "/api/campers/register", { ...base, emergencyContact: { name: "Vó", phone: "123" } }, token)).body.error.code).toBe("EMERGENCY_CONTACT_INVALID");
    expect((await call("POST", "/api/campers/register", { ...base, homeChurch: "x".repeat(121) }, token)).body.error.code).toBe("HOME_CHURCH_INVALID");
    expect(core.callsTo("POST /registrations")).toHaveLength(0);
  });

  test("staff register sends sex and homeChurch with the person", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("POST", "/api/staff/register", { name: "caio servo", phone: "11955554444", sex: "M", homeChurch: "IPAlpha" }, token);
    expect(res.status).toBe(201);
    expect((core.callsTo("POST /registrations")[0].json as Record<string, any>).people[0]).toMatchObject({ name: "Caio Servo", phone: "+5511955554444", sex: "male", homeChurch: "IPAlpha" });
  });

  test("decision 57: no standalone second-responsável path — nothing reaches persons /links", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await createApp().request(`/api/campers/${KID_A}/responsibles`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "tio paulo", phone: "11977776666" }) });
    expect(res.status).toBe(404);
    expect(core.callsTo("POST /links")).toHaveLength(0);
    expect(core.callsTo("POST /registrations")).toHaveLength(0);
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
    expect(res.body.items).toEqual([{ personId: KID_A, name: "Ana Pequena", nickname: null, sex: "F" }]);
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("POST", "/api/people/names", { personIds: [KID_A, KID_B] }, admin)).body.items).toHaveLength(2);
    expect((await call("POST", "/api/people/names", { personIds: Array.from({ length: 201 }, (_, i) => `p${i}`) }, admin)).status).toBe(400);
  });

  test("names go with the requester's acting role token; ids core leaves out (roles policy seesNamesOf) are simply absent", async () => {
    core.on("POST /projects/project-test-1/people/names", (c) => {
      const ids = (c.json as { personIds: string[] }).personIds.filter((id) => id !== KID_B);
      return new Response(JSON.stringify({ items: ids.map((id) => ({ personId: id, name: world.names.get(id) })) }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("POST", "/api/people/names", { personIds: [KID_A, KID_B] }, admin);
    expect(res.body.items.map((i: { personId: string }) => i.personId)).toEqual([KID_A]);
    const asked = core.callsTo("POST /projects/project-test-1/people/names").at(-1)!;
    expect(JSON.parse(atob((asked.headers.get("authorization") ?? "").split(".")[1]))).toMatchObject({ sub: ADMIN, projectRole: "coordenacao" });
    const list = await call("GET", "/api/campers", undefined, admin);
    expect(list.body.items.find((k: { id: string }) => k.id === KID_B)).toMatchObject({ name: "" });
  });

  test("there is no health queue in Acampa any more (decision 50)", async () => {
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const app = (await import("../app")).createApp();
    const headers = { authorization: `Bearer ${admin}`, "content-type": "application/json" };
    expect((await app.request("/api/people/health-queue", { headers })).status).toBe(404);
    expect((await app.request("/api/people/health-queue/flush", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await (await rawDb()).listCollections({ name: "healthQueue" }).toArray()).length).toBe(0);
  });
});

describe("message templates live in the Developers portal", () => {
  test("Acampa has no template routes and never calls projects-api templates", async () => {
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const app = createApp();
    const headers = { authorization: `Bearer ${admin}`, "content-type": "application/json" };
    expect((await app.request("/api/settings/message-templates", { headers })).status).toBe(404);
    expect((await app.request("/api/settings/message-templates/seed", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect(core.calls.filter((c) => c.path.includes("message-templates"))).toEqual([]);
  });
});

describe("medication and generic medical read boundaries", () => {
  test("organização cannot read dose details through REST, snapshot or assistant", async () => {
    world.memberships.push({ personId: ADMIN, role: "organizacao", editionId: TEST_EDITION });
    const token = await sessionFor(keys, ADMIN, ["organizacao"]);
    expect((await call("GET", "/api/medications", undefined, token)).status).toBe(403);
    const snapshot = await loadCollections({ activeRole: "staff", coreRole: "organizacao", personId: ADMIN }, ["medications"]);
    expect(snapshot.medications).toBeUndefined();
    const { assistantAllowlist } = await import("../services/assistantTools");
    expect(assistantAllowlist("organizer").medicationDoses).toBeUndefined();
  });

  test("generic medical reads redact sensitive fields for caretakers like the camper page", async () => {
    world.health.set(KID_A, { ...world.health.get(KID_A), neurodivergent: true, insurance: "private", insuranceCard: "secret" });
    const token = await sessionFor(keys, CARE, ["equipe"]);
    const res = await call("GET", `/api/people/${KID_A}/data/medical`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.data.health.allergies).toEqual(["amendoim"]);
    expect(res.body.data.health.neurodivergent).toBeUndefined();
    expect(res.body.data.health.insurance).toBeUndefined();
    expect(res.body.data.health.insuranceCard).toBeUndefined();
  });

  test("health role dose reads omit people core no longer permits", async () => {
    const { insertMedicationDose } = await import("../models/medications");
    await insertMedicationDose({ personId: KID_A, medKey: "test", medName: "Synthetic medicine", dose: "1", day: "2026-10-05", slot: "08:00", byPersonId: MEDIC, note: "" }, true);
    world.medicalForbidden.add(KID_A);
    const token = await sessionFor(keys, MEDIC, ["saude"]);
    expect((await call("GET", "/api/medications", undefined, token)).body.medications).toEqual([]);
    const { findSessionByToken } = await import("../services/session");
    const session = (await findSessionByToken(token))!;
    expect((await loadCollections({ activeRole: "staff", coreRole: "saude", personId: MEDIC, sessionId: session._id }, ["medications"])).medications).toEqual([]);
    const { runAssistantTool } = await import("../services/assistantTools");
    const result = JSON.parse(await runAssistantTool("medical", "read_collection", JSON.stringify({ collection: "medicationDoses" }), session));
    expect(result.rows).toEqual([]);
  });
});
