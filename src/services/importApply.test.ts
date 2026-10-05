import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, resetData, startTestDb, stopTestDb, TEST_EDITION, type FakeCore, type FakeWorld } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { camperDataFromPreview, directImportField, IMPORT_FIELDS, insertImportCampers, type ImportCoreContext } from "./camperImport";
import { registerAdult } from "./coreRegistration";

/**
 * Applying a spreadsheet against people core ALREADY knows (decision 38 + the
 * health safety rule): an existing person's health is merged, never replaced,
 * and an optional second responsável joins the same kid through `/links`.
 */
let core: FakeCore;
let world: FakeWorld;
const ctx: ImportCoreContext = { tokens: { persons: "coord-persons", projects: "coord-projects" }, editionId: TEST_EDITION };

const KID = "person-mia";
const MOM = "person-rosa";
const KNOWN_HEALTH = {
  allergies: ["amendoim"],
  drugAllergies: ["dipirona"],
  healthIssues: [],
  neurodivergent: true,
  medications: [{ name: "Ritalina", dose: "10mg", times: ["08:00"], asNeeded: false, notes: "" }],
  foodRestrictions: "sem lactose",
  healthNotes: "asma leve",
  weightKg: 28,
  insurance: "Unimed",
  insuranceCard: "123",
};

function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { row: 2, name: "Mia Antiga", birthDate: "2016-01-10", guardianName: "Rosa Antiga", guardianPhone: "+5511933332222", guardianEmail: "", blocked: false, ...extra };
}

beforeAll(async () => {
  await startTestDb();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  installFakeCore(core, world);
  enableIpalpha(core, await createTestKeys());
  // the family registered Mia last year: core knows Rosa's phone and Mia (linked to her)
  world.names.set(KID, "Mia Antiga");
  world.births.set(KID, "2016-01-10");
  world.names.set(MOM, "Rosa Antiga");
  world.phones.set("+5511933332222", MOM);
  world.links.push({ subjectId: KID, agentId: MOM });
  world.health.set(KID, structuredClone(KNOWN_HEALTH));
});

describe("import apply never erases health core already holds", () => {
  test("an existing kid keeps every allergy, medicine and note; the sheet only adds", async () => {
    const res = await insertImportCampers([row({ allergies: ["amendoim"], drugAllergies: [], healthIssues: [], foodRestrictions: "", healthNotes: "usa óculos", insurance: "", insuranceCard: "", neurodivergent: false })], "imp-1", ctx);
    expect(res.inserted).toBe(1);
    expect(res.skipped).toEqual([]);
    const reg = core.callsTo("POST /registrations")[0].json as { children: { data?: Record<string, unknown> }[] };
    expect(reg.children[0].data?.medical).toBeUndefined();
    const h = world.health.get(KID)!;
    expect(h).toMatchObject({ allergies: ["amendoim"], drugAllergies: ["dipirona"], neurodivergent: true, foodRestrictions: "sem lactose", weightKg: 28, insurance: "Unimed", insuranceCard: "123" });
    expect(h.medications).toEqual(KNOWN_HEALTH.medications);
    expect(h.healthNotes).toBe("asma leve usa óculos");
  });

  test("a sheet with nothing new about health writes nothing", async () => {
    await insertImportCampers([row({ allergies: ["amendoim"], healthNotes: "asma leve" })], "imp-1", ctx);
    expect(core.callsTo(`PATCH /persons/${KID}/data/medical`)).toHaveLength(0);
    expect(world.health.get(KID)).toEqual(KNOWN_HEALTH);
  });

  test("health core refuses to show is never written blind; the row is imported with a note", async () => {
    world.medicalForbidden.add(KID);
    const res = await insertImportCampers([row({ healthNotes: "outra coisa" })], "imp-1", ctx);
    expect(res.inserted).toBe(1);
    expect(res.skipped).toEqual([expect.objectContaining({ row: 2, reason: expect.stringContaining("nada do que já existia foi alterado") })]);
    expect(core.callsTo(`PATCH /persons/${KID}/data/medical`)).toHaveLength(0);
    expect(world.health.get(KID)).toEqual(KNOWN_HEALTH);
  });

  test("a new kid gets the sheet's health without a read first", async () => {
    const res = await insertImportCampers([row({ name: "Leo Novo", birthDate: "2017-02-02", allergies: ["amendoim"] })], "imp-1", ctx);
    expect(res.inserted).toBe(1);
    const kid = (await (await rawDb()).collection("participants").findOne({ kind: "camper" }))!.personId as string;
    expect(kid).not.toBe(KID);
    expect(world.health.get(kid)).toMatchObject({ allergies: ["amendoim"] });
    expect(core.callsTo(`GET /persons/${kid}/data/medical`)).toHaveLength(0);
  });

  test("an existing team member (staff import / wizard) keeps their health too", async () => {
    world.names.set("person-gil", "Gil Monitor");
    world.phones.set("+5511944443333", "person-gil");
    world.health.set("person-gil", { ...structuredClone(KNOWN_HEALTH), allergies: ["camarão"] });
    const out = await registerAdult(ctx.tokens, { name: "Gil Monitor", phone: "11944443333", roles: ["equipe"], editionId: TEST_EDITION, health: { healthNotes: "", allergies: [] } });
    expect(out).toMatchObject({ personId: "person-gil", created: false, medical: "unchanged" });
    expect(world.health.get("person-gil")).toMatchObject({ allergies: ["camarão"], healthNotes: "asma leve" });
  });
});

describe("second responsável columns (decision 38)", () => {
  test("the import knows the optional columns and recognizes common headers", () => {
    expect(IMPORT_FIELDS.map((f) => f.key)).toEqual(expect.arrayContaining(["guardian2Name", "guardian2Phone"]));
    expect(directImportField("Nome do 2º responsável")?.key).toBe("guardian2Name");
    expect(directImportField("Segundo responsável")?.key).toBe("guardian2Name");
    expect(directImportField("Telefone do 2º responsável")?.key).toBe("guardian2Phone");
    expect(directImportField("Telefone do responsável 2")?.key).toBe("guardian2Phone");
    // the first responsável's headers still win their own field
    expect(directImportField("Nome do responsável")?.key).toBe("guardianName");
    expect(directImportField("Telefone do responsável")?.key).toBe("guardianPhone");
  });

  test("the preview row carries the second responsável; a name without a valid celular is flagged, not blocking", () => {
    expect(camperDataFromPreview(row({ guardian2Name: "Davi Antigo", guardian2Phone: "+5511922221111" }), "imp")?.guardian2).toEqual({ name: "Davi Antigo", phone: "+5511922221111" });
    expect(camperDataFromPreview(row(), "imp")?.guardian2).toBeNull();
    expect(camperDataFromPreview(row({ guardian2Name: "Davi", guardian2Phone: null }), "imp")?.guardian2).toEqual({ invalid: true });
  });

  test("on apply the second responsável is registered and linked to the SAME kid through persons /links", async () => {
    const res = await insertImportCampers([row({ guardian2Name: "Davi Antigo", guardian2Phone: "+5511922221111" })], "imp-1", ctx);
    expect(res.inserted).toBe(1);
    expect(res.skipped).toEqual([]);
    const dad = world.phones.get("+5511922221111")!;
    expect(dad).toBeTruthy();
    const link = core.callsTo("POST /links").map((c) => c.json);
    expect(link).toEqual([expect.objectContaining({ subjectId: KID, agentId: dad })]);
    expect(world.memberships.find((m) => m.personId === KID && m.role === "participante")?.involved?.map((i) => i.personId).sort()).toEqual([MOM, dad].sort());
    expect(world.memberships).toContainEqual(expect.objectContaining({ personId: dad, role: "responsavel", editionId: TEST_EDITION }));
    // the kid is never copied
    expect([...world.names.values()].filter((n) => n === "Mia Antiga")).toHaveLength(1);
  });

  test("an invalid second responsável leaves a note and the kid is still imported", async () => {
    const res = await insertImportCampers([row({ guardian2Name: "Davi", guardian2Phone: null })], "imp-1", ctx);
    expect(res.inserted).toBe(1);
    expect(res.skipped).toEqual([expect.objectContaining({ row: 2, reason: expect.stringContaining("2º responsável") })]);
    expect(core.callsTo("POST /links")).toHaveLength(0);
  });

  test("the same celular as the first responsável is not linked twice", async () => {
    await insertImportCampers([row({ guardian2Name: "Rosa", guardian2Phone: "+5511933332222" })], "imp-1", ctx);
    expect(core.callsTo("POST /links")).toHaveLength(0);
  });
});
