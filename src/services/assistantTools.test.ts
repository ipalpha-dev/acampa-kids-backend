import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resetData, startTestDb, stopTestDb } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { activeCampId } from "./campContext";
import { assistantAllowlist, runAssistantTool } from "./assistantTools";

/** decision 90: the assistant reads new-shape collections + fields only — never a legacy collection or a person-data field. */

const LEGACY_PERSON_FIELDS = ["name", "phone", "email", "guardianPhone", "guardianName", "birthDate", "health", "allergies", "healthNotes", "medications", "document", "cpf"];

beforeAll(startTestDb);
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  const db = await rawDb();
  const campId = activeCampId();
  // a row carrying fields of an OLDER shape (name / phone / health snapshots) next to the camp-ops ones
  await db.collection("participants").insertOne({
    campId, personId: "person-kid", kind: "camper", bedroom: "b1", team: "t1", qrToken: "secret-qr",
    name: "Ana Legada", phone: "+5511999990000", email: "ana@example.com", health: { allergies: ["amendoim"] }, healthNotes: "asma",
  } as never);
  await db.collection("campers").insertOne({ campId, name: "Ana Legada", guardianPhone: "+5511999990000" } as never);
});

afterEach(async () => {
  await (await rawDb()).collection("campers").drop().catch(() => {});
});

async function run(tool: string, args: Record<string, unknown>, audience: "all" | "medical" = "all"): Promise<Record<string, unknown>> {
  return JSON.parse(await runAssistantTool(audience, tool, JSON.stringify(args))) as Record<string, unknown>;
}

describe("assistant tools — allowlists only", () => {
  test("no legacy collection is reachable (campers / staff / users / camperImports / sessions)", async () => {
    for (const audience of ["all", "medical"] as const) {
      const allowed = Object.keys(assistantAllowlist(audience));
      for (const legacy of ["campers", "staff", "users", "camperImports", "camperImportDictionary", "healthQueue", "sessions", "importJobs", "ipalphaLoginStates"]) expect(allowed).not.toContain(legacy);
    }
    const res = await run("read_collection", { collection: "campers" });
    expect(String(res.error)).toContain("não permitida");
  });

  test("no allowlisted field is a person-data field, a token or a binary", () => {
    // `name` is a camp label on bedrooms / teams / cars / categories / roles / files; on rows about a PERSON it is never allowed
    const personRows = new Set(["participants", "checkinLog", "camperChangeLog", "camperLookups", "medicationDoses", "occurrences", "scores", "gallery"]);
    for (const [name, fields] of Object.entries(assistantAllowlist("all"))) {
      const banned = personRows.has(name) ? LEGACY_PERSON_FIELDS : LEGACY_PERSON_FIELDS.filter((f) => f !== "name");
      for (const f of [...banned, "qrToken", "thumb", "faces", "data", "jobToken", "userId", "deleteOtp", "birthdayNoticeDay"]) {
        expect({ name, has: fields.includes(f) }).toEqual({ name, has: false });
      }
    }
  });

  test("read_collection returns only allowlisted fields, even from a document of an older shape", async () => {
    const res = await run("read_collection", { collection: "participants", projection: { name: 1, phone: 1, bedroom: 1 } });
    const rows = res.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ _id: expect.any(String), bedroom: "b1" });
    const all = (await run("read_collection", { collection: "participants" })).rows as Record<string, unknown>[];
    expect(all[0]).toMatchObject({ personId: "person-kid", bedroom: "b1", team: "t1" });
    const serialized = JSON.stringify(all);
    for (const leak of ["Ana Legada", "+5511999990000", "ana@example.com", "amendoim", "asma", "secret-qr"]) expect(serialized).not.toContain(leak);
  });

  test("a filter / sort on a non-allowlisted field matches nothing (no oracle)", async () => {
    const res = await run("read_collection", { collection: "participants", filter: { name: "Ana Legada" } });
    expect(res.returned).toBe(0);
    const byPhone = await run("read_collection", { collection: "participants", filter: { phone: { $exists: true } } });
    expect(byPhone.returned).toBe(0);
  });

  test("aggregate_collection never sees a non-allowlisted field", async () => {
    const res = await run("aggregate_collection", { collection: "participants", pipeline: [{ $group: { _id: "$name", phones: { $push: "$phone" }, notes: { $push: "$healthNotes" } } }] });
    expect(res.rows).toEqual([{ _id: null, phones: [], notes: [] }]);
    const medical = await run("aggregate_collection", { collection: "participants", pipeline: [{ $project: { n: "$name", h: "$health" } }] }, "medical");
    expect(JSON.stringify(medical)).not.toContain("Ana Legada");
    expect(JSON.stringify(medical)).not.toContain("amendoim");
  });

  test("list_collections lists the allowlisted fields (not a sample document's keys)", async () => {
    const list = JSON.parse(await runAssistantTool("all", "list_collections", "{}")) as { collection: string; fields: string[] }[];
    const participants = list.find((c) => c.collection === "participants")!;
    expect(participants.fields).toContain("bedroom");
    for (const f of LEGACY_PERSON_FIELDS) expect(participants.fields).not.toContain(f);
  });
});
