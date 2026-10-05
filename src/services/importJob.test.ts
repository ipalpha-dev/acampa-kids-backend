import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { config } from "../config";
import { EMPTY_CAMPER, claimCampersForAiReview, insertCamper, releaseCamperReview } from "../models/campers";
import { endImportJobIfIdle, findCamperImport, insertCamperImport, listPausedImportIds, openImportJobToken, pauseImportForSignIn, storeImportJobToken } from "../models/camperImports";
import { findSessionByToken } from "./session";
import { coordinationJobToken } from "./acting";
import { startImportJob } from "./importJob";
import { ImportNeedsSignIn, importToken, writeImportHealth } from "./importHealth";
import { IpalphaTokenRevoked } from "./ipalpha/coreClient";
import worker from "../routes/worker";

/** Decision 50: the import job's AI health pass writes to persons-api with the importer's sealed token. */
const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ADMIN = "person-admin";
const OTHER_ADMIN = "person-admin-2";
const KID = "person-kid-a";
const TOKEN = "role-token-of-the-importer";

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  world.names.set(KID, "Ana Pequena");
  world.health.set(KID, { allergies: ["amendoim"], drugAllergies: [], healthIssues: [], neurodivergent: false, medications: [], foodRestrictions: "", healthNotes: "asma leve", weightKg: 30, insurance: "", insuranceCard: "" });
  world.memberships.push({ personId: ADMIN, role: "coordenacao" }, { personId: OTHER_ADMIN, role: "coordenacao" }, { personId: KID, role: "participante", editionId: TEST_EDITION });
  installFakeCore(core, world);
  enableIpalpha(core, keys);
});

async function newImport(status: "completed" | "importing" | "error" = "completed", by = ADMIN): Promise<string> {
  const record = await insertCamperImport({
    fileName: "kids.xlsx", subject: "camper", fileType: "", fileHash: "h", status, dryRun: false,
    columns: [], rows: [], dictionaries: [], reviews: [], preview: [], skipped: [], createdItems: [], dateFunction: "",
    startedAt: new Date(), reviewStartedAt: new Date(), finishedAt: null, finishedSmsSentAt: null, errorSmsSentAt: null, notificationCheckedAt: null,
    createdByPersonId: by, error: "",
  });
  return record._id;
}

describe("the job token", () => {
  test("Apply seals the importer's coordenação persons token on the job — never stored in clear", async () => {
    const browser = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const session = (await findSessionByToken(browser))!;
    const id = await newImport("importing");
    expect(await startImportJob(id, session)).toBe(true);
    const raw = await (await rawDb()).collection("camperImports").findOne({});
    const plain = coordinationJobToken(session)!.token;
    expect(typeof raw?.jobToken).toBe("string");
    expect(String(raw?.jobToken)).not.toContain(plain);
    expect(String(raw?.jobToken)).not.toContain("eyJ");
    expect((await openImportJobToken(id))?.token).toBe(plain);
    // the API never answers it
    const res = await call("GET", `/api/camper-imports/${id}`, undefined, browser);
    expect(JSON.stringify(res.body)).not.toContain("jobToken");
    expect(res.body.import).toMatchObject({ status: "importing", needsSignIn: false, pausedAt: null });
  });

  test("a session without coordenação has no job token; an expired token reads as none", async () => {
    const browser = await sessionFor(keys, "person-care", ["equipe"]);
    expect(await startImportJob(await newImport(), (await findSessionByToken(browser))!)).toBe(false);
    const id = await newImport();
    await storeImportJobToken(id, { token: TOKEN, expiresAt: Date.now() - 1 });
    expect(await openImportJobToken(id)).toBeNull();
    expect(importToken(id)).rejects.toBeInstanceOf(ImportNeedsSignIn);
  });

  test("the job ends (token deleted) only when nothing of the import waits for the worker", async () => {
    const id = await newImport();
    await storeImportJobToken(id, { token: TOKEN, expiresAt: Date.now() + 60_000 });
    await insertCamper(KID, { ...EMPTY_CAMPER, importId: id, aiReviewStatus: "pending", aiReviewError: "", aiReviewStartedAt: null, aiReviewFinishedAt: null } as never);
    expect(await endImportJobIfIdle(id)).toBe(false);
    expect(await openImportJobToken(id)).not.toBeNull();
    await (await rawDb()).collection("participants").updateOne({ personId: KID }, { $set: { aiReviewStatus: "reviewed" } });
    expect(await endImportJobIfIdle(id)).toBe(true);
    expect((await (await rawDb()).collection("camperImports").findOne({}))?.jobToken).toBeUndefined();
  });
});

describe("AI health written straight to persons-api", () => {
  test("merged over the current block — lists unioned, texts appended, nothing erased", async () => {
    expect(await writeImportHealth(TOKEN, KID, { allergies: [], healthNotes: "usa bombinha", foodRestrictions: "", neurodivergent: false })).toBe("written");
    expect(world.health.get(KID)).toMatchObject({ allergies: ["amendoim"], healthNotes: "asma leve usa bombinha", weightKg: 30 });
    const patch = core.callsTo(`PATCH /persons/${KID}/data/medical`)[0];
    expect(patch.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    // the same result again changes nothing → no write
    expect(await writeImportHealth(TOKEN, KID, { healthNotes: "usa bombinha" })).toBe("unchanged");
    expect(core.callsTo(`PATCH /persons/${KID}/data/medical`)).toHaveLength(1);
  });

  test("a role that may not read the block never writes blind (refused); a person without a block starts empty", async () => {
    world.medicalForbidden.add(KID);
    expect(await writeImportHealth(TOKEN, KID, { healthNotes: "x" })).toBe("refused");
    expect(core.callsTo(`PATCH /persons/${KID}/data/medical`)).toHaveLength(0);
    world.medicalForbidden.clear();
    world.health.delete(KID);
    expect(await writeImportHealth(TOKEN, KID, { allergies: ["amendoim"] })).toBe("written");
    expect(world.health.get(KID)).toMatchObject({ allergies: ["amendoim"], healthNotes: "" });
  });

  test("a revoked token is IpalphaTokenRevoked (the worker pauses the job), nothing is written", async () => {
    world.revoked.add(TOKEN);
    expect(writeImportHealth(TOKEN, KID, { healthNotes: "x" })).rejects.toBeInstanceOf(IpalphaTokenRevoked);
    expect(world.health.get(KID)).toMatchObject({ healthNotes: "asma leve" });
  });

  test("no health ever rests in Acampa's Mongo", async () => {
    await writeImportHealth(TOKEN, KID, { healthNotes: "usa bombinha" });
    const db = await rawDb();
    for (const c of await db.listCollections().toArray()) {
      const docs = await db.collection(c.name).find({}).toArray();
      expect(JSON.stringify(docs)).not.toContain("bombinha");
    }
  });
});

describe("pause → sign in again → resume", () => {
  test("a paused job drops its dead token and its rows are left alone until the resume", async () => {
    const id = await newImport();
    await storeImportJobToken(id, { token: TOKEN, expiresAt: Date.now() + 60_000 });
    await insertCamper(KID, { ...EMPTY_CAMPER, importId: id, aiReviewStatus: "pending", aiReviewError: "", aiReviewStartedAt: null, aiReviewFinishedAt: null } as never);
    expect(await pauseImportForSignIn(id)).toBe(true);
    expect(await pauseImportForSignIn(id)).toBe(false); // once
    const record = (await findCamperImport(id))!;
    expect(record.status).toBe("needsSignIn");
    expect(record.pausedAt).toBeInstanceOf(Date);
    expect(await openImportJobToken(id)).toBeNull();
    const paused = await listPausedImportIds();
    expect(paused).toEqual([id]);
    expect(await claimCampersForAiReview(15, paused)).toHaveLength(0);
    // a row claimed just before the pause is put back without counting an attempt
    const [claimed] = await claimCampersForAiReview(15);
    await releaseCamperReview(claimed._id, false);
    const row = await (await rawDb()).collection("participants").findOne({ personId: KID });
    expect(row).toMatchObject({ aiReviewStatus: "pending" });
    expect(row?.aiReviewAttempts ?? 0).toBe(0);
  });

  test("an import that ended in error cannot pause (the worker fails the row instead)", async () => {
    expect(await pauseImportForSignIn(await newImport("error"))).toBe(false);
  });

  test("the importer sees the paused job, signs in again and resumes it with the fresh token", async () => {
    const id = await newImport();
    await pauseImportForSignIn(id);
    const browser = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const listed = await call("GET", "/api/camper-imports/needs-sign-in", undefined, browser);
    expect(listed.body.imports).toEqual([expect.objectContaining({ id, fileName: "kids.xlsx" })]);
    expect((await call("GET", `/api/camper-imports/${id}`, undefined, browser)).body.import).toMatchObject({ status: "needsSignIn", needsSignIn: true });
    const res = await call("POST", `/api/camper-imports/${id}/resume`, {}, browser);
    expect(res.status).toBe(200);
    expect(res.body.import).toMatchObject({ status: "completed", needsSignIn: false, pausedAt: null });
    const fresh = coordinationJobToken((await findSessionByToken(browser))!)!.token;
    expect((await openImportJobToken(id))?.token).toBe(fresh);
    expect((await call("GET", "/api/camper-imports/needs-sign-in", undefined, browser)).body.imports).toEqual([]);
  });

  test("resume: only the importer, only a paused job, only as coordenação, only its own subject", async () => {
    const id = await newImport();
    const importer = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("POST", `/api/camper-imports/${id}/resume`, {}, importer)).body.error.code).toBe("IMPORT_NOT_PAUSED");
    await pauseImportForSignIn(id);
    const other = await sessionFor(keys, OTHER_ADMIN, ["coordenacao"]);
    const notYours = await call("POST", `/api/camper-imports/${id}/resume`, {}, other);
    expect(notYours.status).toBe(403);
    expect(notYours.body.error.code).toBe("IMPORT_NOT_YOURS");
    expect((await call("GET", "/api/camper-imports/needs-sign-in", undefined, other)).body.imports).toEqual([]);
    expect((await call("POST", `/api/staff-imports/${id}/resume`, {}, importer)).status).toBe(404);
    expect((await call("POST", "/api/camper-imports/000000000000000000000000/resume", {}, importer)).status).toBe(404);
    world.memberships.push({ personId: ADMIN, role: "organizacao", editionId: TEST_EDITION });
    const organizer = await sessionFor(keys, ADMIN, ["organizacao"]);
    expect((await call("POST", `/api/camper-imports/${id}/resume`, {}, organizer)).body.error.code).toBe("COORDINATION_REQUIRED");
    expect((await findCamperImport(id))?.status).toBe("needsSignIn");
  });
});

describe("POST /api/worker/import-paused", () => {
  const SECRET = "test-worker-secret";
  const post = (body: unknown, auth = `Bearer ${SECRET}`) =>
    worker.request("/import-paused", { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });

  test("shared secret, a body with importId, a known import", async () => {
    (config.worker as { secret: string }).secret = SECRET;
    const id = await newImport();
    expect((await post({ importId: id }, "Bearer wrong")).status).toBe(401);
    expect((await post({})).status).toBe(400);
    expect((await post({ importId: "000000000000000000000000" })).status).toBe(404);
    expect(await (await post({ importId: id })).json()).toEqual({ ok: true, needsSignIn: false });
    await pauseImportForSignIn(id);
    expect(await (await post({ importId: id })).json()).toEqual({ ok: true, needsSignIn: true });
  });
});
