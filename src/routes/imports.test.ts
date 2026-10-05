import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, json, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, TEST_ENV, TEST_PROJECT, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { createApp } from "../app";
import { insertBedroom } from "../models/bedrooms";
import { findCamperById, EMPTY_CAMPER, insertCamper } from "../models/campers";
import { findStaffById } from "../models/staff";
import { insertTeam } from "../models/teams";
import { insertTransport } from "../models/transports";
import { addClient, removeClient, type RealtimeClient } from "../services/realtime";
import { findSessionByToken, hashToken } from "../services/session";
import { trackedImport } from "../services/personImports";

const call = testApp();
const app = createApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ADMIN = "person-admin";
const ORGANIZER = "person-organizer";
const KID_A = "person-kid-a";
const KID_B = "person-kid-b";
const KID_C = "person-kid-c";
const LEADER = "person-leader";
const SECRET = "whsec_test_secret_value";
const IMPORT_ID = "imp-1";
let busId: string;
let carId: string;
let roomId: string;
let teamId: string;

/** the persons-api import job core keeps (rows never leave core — §20) */
let job: Record<string, unknown>;
let batches: { batch: number; rows: Record<string, unknown>[] }[];

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  world.memberships.push(
    { personId: ADMIN, role: "coordenacao" },
    { personId: ORGANIZER, role: "organizacao", editionId: TEST_EDITION },
    { personId: KID_A, role: "participante", editionId: TEST_EDITION },
    { personId: KID_B, role: "participante", editionId: TEST_EDITION },
    { personId: KID_C, role: "participante", editionId: TEST_EDITION },
    { personId: LEADER, role: "equipe", editionId: TEST_EDITION },
  );
  installFakeCore(core, world);
  enableIpalpha(core, keys, { ...TEST_ENV, IPALPHA_WEBHOOK_SECRET: SECRET });
  busId = (await insertTransport({ kind: "bus", number: "1", color: "#1e6fd9", order: 0 }))._id;
  carId = (await insertTransport({ kind: "car", name: "Carro do João", order: 1 }))._id;
  roomId = (await insertBedroom({ name: "3", group: "girls", bunkBeds: 0, singleBeds: 1, notes: "" }))._id;
  teamId = (await insertTeam({ name: "Time Azul", color: "#1e6fd9", order: 0 }))._id;
  job = {
    id: IMPORT_ID,
    projectId: TEST_PROJECT,
    editionId: TEST_EDITION,
    status: "review",
    targets: { camper: "participante", responsible: "responsavel" },
    steps: [{ name: "mapping", done: 1, total: 1 }, { name: "matching", done: 3, total: 3 }],
    file: { name: "inscricoes.xlsx", size: 1234, sheet: "Respostas" },
    mapping: { "Nome da criança": "name", "Ônibus": "app:transportation" },
    reviews: [{ id: "r1", rowRef: "4", kind: "possibleMatch", message: "Pessoa parecida já cadastrada", candidates: [{ personId: KID_A }] }],
    appFields: [{ key: "transportation", emptyRows: 2, categoryMapping: { "Ônibus azul": busId } }],
    counts: { rows: 3, created: 0, updated: 0, skipped: 0, failed: 0 },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  batches = [];
  core.on(`POST /projects/${TEST_PROJECT}/imports`, () => json({ ...job, status: "analysing" }, 201));
  core.on("GET /imports/:id", () => json(job));
  core.on("PATCH /imports/:id", (c) => {
    job = { ...job, appFields: [{ key: "transportation", emptyRows: 2, decision: (c.json as { required?: Record<string, unknown> }).required?.transportation ?? null }] };
    return json(job);
  });
  core.on("POST /imports/:id/apply", () => {
    job = { ...job, status: "applying" };
    return json(job);
  });
  core.on("DELETE /imports/:id", () => json({}, 204));
  core.on("GET /imports/:id/batches", () => json({ items: batches, nextCursor: null }));
});

function upload(token: string, fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return app.request("/api/imports", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
}

function signed(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliver(message: Record<string, unknown>, deliveryId: string, signature?: string) {
  const body = JSON.stringify(message);
  const res = await app.request("/api/dispatch/webhook", { method: "POST", headers: { "content-type": "application/json", "x-ipalpha-signature": signature ?? signed(body), "x-ipalpha-delivery": deliveryId }, body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** let the background queue drain */
const settle = () => new Promise((r) => setTimeout(r, 50));

const batchMessage = (batch: number, rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ id: `msg-${batch}`, type: "person-import.batch", importId: IMPORT_ID, projectId: TEST_PROJECT, step: "apply", done: batch + 1, total: 2, status: "applying", batch, rows, ...extra });

describe("app fields + targets (§20/§24)", () => {
  test("campers: vehicles / rooms / teams are categories keyed by Acampa ids; transportation is required", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/imports/app-fields?subject=camper", undefined, token);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.appFields.map((f: { key: string }) => [f.key, f]));
    expect(Object.keys(byKey)).toEqual(["transportation", "bedroom", "team", "bedroomPreference", "invitedBy", "generalNotes"]);
    expect(byKey.transportation).toMatchObject({ kind: "category", required: true });
    expect(byKey.transportation.categories).toEqual([{ key: busId, label: "Ônibus 1" }, { key: carId, label: "Carona: Carro do João" }]);
    expect(byKey.bedroom.categories).toEqual([{ key: roomId, label: "Quarto 3 (meninas)" }]);
    expect(byKey.generalNotes.description).toContain("NÃO são de saúde");
  });

  test("team: roomRole is a required category", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/imports/app-fields?subject=team", undefined, token);
    expect(res.body.appFields[0]).toMatchObject({ key: "roomRole", kind: "category", required: true });
    expect(res.body.appFields.map((f: { key: string }) => f.key)).not.toContain("invitedBy");
  });
});

describe("the proxy uses the importer's coordenação token", () => {
  test("upload → persons-api multipart with editionId, targets and appFields; 201 {import}", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await upload(token, { subject: "camper", file: new File(["nome,onibus\nAna,azul\n"], "inscricoes.csv", { type: "text/csv" }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { import: Record<string, unknown> };
    expect(body.import).toMatchObject({ id: IMPORT_ID, subject: "camper", status: "analysing", pendingRequired: ["transportation"] });
    const sent = core.callsTo(`POST /projects/${TEST_PROJECT}/imports`)[0];
    const bearer = (sent.headers.get("authorization") ?? "").slice(7);
    expect(JSON.parse(atob(bearer.split(".")[1]))).toMatchObject({ projectRole: "coordenacao", aud: "ipalpha:persons" });
    expect(sent.multipart?.get("editionId")).toBe(TEST_EDITION);
    expect(JSON.parse(String(sent.multipart?.get("targets")))).toEqual({ camper: "participante", responsible: "responsavel" });
    expect(JSON.parse(String(sent.multipart?.get("appFields"))).map((f: { key: string }) => f.key)).toContain("transportation");
    expect((sent.multipart?.get("file") as File).name).toBe("inscricoes.csv");
    expect(trackedImport(IMPORT_ID)).toMatchObject({ personId: ADMIN, subject: "camper" });
  });

  test("an organizer without coordenação cannot import; bad files are refused before core", async () => {
    const org = await sessionFor(keys, ORGANIZER, ["organizacao"]);
    const res = await upload(org, { subject: "camper", file: new File(["a"], "a.csv") });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("COORDINATION_REQUIRED");
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect(((await (await upload(token, { subject: "camper", file: new File(["a"], "a.pdf") })).json()) as { error: { code: string } }).error.code).toBe("FILE_TYPE_INVALID");
    expect(((await (await upload(token, { subject: "kids", file: new File(["a"], "a.csv") })).json()) as { error: { code: string } }).error.code).toBe("SUBJECT_INVALID");
    expect(((await (await upload(token, { subject: "camper", file: new File([new Uint8Array(5 * 1024 * 1024 + 1)], "a.csv") })).json()) as { error: { code: string } }).error.code).toBe("FILE_TOO_LARGE");
    expect(core.callsTo(`POST /projects/${TEST_PROJECT}/imports`)).toHaveLength(0);
  });

  test("decisions are validated against Acampa's categories before PATCH; apply / cancel go through", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const bad = await call("PATCH", `/api/imports/${IMPORT_ID}`, { required: { transportation: { mode: "default", value: "not-a-vehicle" } } }, token);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("DECISIONS_INVALID");
    expect((await call("PATCH", `/api/imports/${IMPORT_ID}`, { categories: { invitedBy: { x: "y" } } }, token)).status).toBe(400);
    const ok = await call("PATCH", `/api/imports/${IMPORT_ID}`, { required: { transportation: { mode: "default", value: busId } }, reviews: { r1: { choice: "match", personId: KID_A } } }, token);
    expect(ok.status).toBe(200);
    expect(ok.body.import.pendingRequired).toEqual([]);
    expect(ok.body.import.appFields[0].decision).toEqual({ mode: "default", value: busId });
    expect(core.callsTo(`PATCH /imports/${IMPORT_ID}`)[0].json).toEqual({ required: { transportation: { mode: "default", value: busId } }, reviews: { r1: { choice: "match", personId: KID_A } } });
    expect((await call("POST", `/api/imports/${IMPORT_ID}/apply`, {}, token)).body.import.status).toBe("applying");
    expect((await call("DELETE", `/api/imports/${IMPORT_ID}`, undefined, token)).body).toEqual({ success: true });
  });

  test("core refusing apply (decisionsPending) reaches the browser as 409 with the reason", async () => {
    core.on("POST /imports/:id/apply", () => json({ reason: "decisionsPending" }, 409));
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("POST", `/api/imports/${IMPORT_ID}/apply`, {}, token);
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe("decisionsPending");
  });
});

describe("webhook (§21/§22): HMAC, idempotent, batches → participants", () => {
  test("a wrong / missing signature is refused; no secret configured = 503", async () => {
    const msg = batchMessage(0, []);
    expect((await deliver(msg, "d-1", signed(JSON.stringify(msg), "other-secret"))).status).toBe(401);
    expect((await deliver(msg, "d-1", "sha256=zz")).status).toBe(401);
    enableIpalpha(core, keys, TEST_ENV);
    expect((await deliver(msg, "d-1")).status).toBe(503);
  });

  test("a batch fills the kids' camp ops by personId; categories are checked; a duplicate delivery changes nothing", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    await upload(token, { subject: "camper", file: new File(["x"], "x.csv") });
    const sock = { sent: [] as string[], ws: { readyState: 1, send(s: string) { sock.sent.push(s); }, close() {} } };
    const client: RealtimeClient = { ws: sock.ws as never, role: "admin", coreRole: "coordenacao", personId: ADMIN, sessionId: hashToken(token), campId: (await findSessionByToken(token))!.campId };
    addClient(client);
    const rows = [
      { rowRef: 2, personId: KID_A, status: "created", appFields: { transportation: busId, bedroom: roomId, team: teamId, invitedBy: "Tia Bia", generalNotes: "gosta de desenhar" }, unfilled: [] },
      { rowRef: 3, personId: KID_B, status: "updated", appFields: { transportation: "unknown-bus", bedroom: roomId }, unfilled: ["team"] },
      { rowRef: 4, status: "failed", reason: "duplicate", appFields: {}, unfilled: [] },
    ];
    const first = await deliver(batchMessage(0, rows), "d-batch-0");
    expect(first.status).toBe(202);
    await settle();
    const a = await findCamperById(KID_A);
    expect(a).toMatchObject({ transportation: busId, bedroom: roomId, team: teamId, invitedBy: "Tia Bia", generalNotes: "gosta de desenhar", importId: IMPORT_ID });
    expect(a!.qrToken).not.toBe("");
    // the room has one bed: the second kid does not overfill it; the unknown vehicle is not written
    expect(await findCamperById(KID_B)).toMatchObject({ transportation: null, bedroom: null, importId: IMPORT_ID });
    const event = sock.sent.map((x) => JSON.parse(x)).find((e) => e.type === "import-batch");
    expect(event.data).toEqual({ importId: IMPORT_ID, batch: 0, rows: 3, applied: 2, skipped: 1, unfilled: 3 });
    expect(JSON.stringify(event)).not.toContain("Tia Bia");
    // the same delivery again (dispatch retry) → duplicate, nothing re-applied
    const again = await deliver(batchMessage(0, rows), "d-batch-0");
    expect(again.body).toEqual({ ok: true, duplicate: true });
    removeClient(client);
  });

  test("progress reaches only the importer's sockets (ids + counts)", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    await upload(token, { subject: "camper", file: new File(["x"], "x.csv") });
    const mine = { sent: [] as string[], ws: { readyState: 1, send(s: string) { mine.sent.push(s); }, close() {} } };
    const other = { sent: [] as string[], ws: { readyState: 1, send(s: string) { other.sent.push(s); }, close() {} } };
    const campId = (await findSessionByToken(token))!.campId;
    const c1: RealtimeClient = { ws: mine.ws as never, role: "admin", coreRole: "coordenacao", personId: ADMIN, sessionId: "s1", campId };
    const c2: RealtimeClient = { ws: other.ws as never, role: "admin", coreRole: "coordenacao", personId: "someone-else", sessionId: "s2", campId };
    addClient(c1);
    addClient(c2);
    await deliver({ id: "p-1", type: "person-import.progress", importId: IMPORT_ID, projectId: TEST_PROJECT, step: "extracting", done: 5, total: 10, status: "analysing" }, "d-p-1");
    await settle();
    expect(mine.sent.map((x) => JSON.parse(x))).toContainEqual(expect.objectContaining({ type: "import-progress", data: { importId: IMPORT_ID, step: "extracting", done: 5, total: 10, status: "analysing" } }));
    expect(other.sent).toHaveLength(0);
    removeClient(c1);
    removeClient(c2);
  });

  test("an import nobody here started (Mordomia / before a restart): kid or team comes from the live edition role", async () => {
    await deliver(batchMessage(0, [
      { rowRef: 1, personId: KID_C, status: "created", appFields: { transportation: carId }, unfilled: [] },
      { rowRef: 2, personId: LEADER, status: "created", appFields: { roomRole: "caretaker" }, unfilled: [] },
    ]), "d-x");
    await settle();
    expect(await findCamperById(KID_C)).toMatchObject({ transportation: carId });
    expect(await findStaffById(LEADER)).toMatchObject({ roomRole: "caretaker" });
  });

  test("a batch too big for dispatch (no rows) is read from persons-api with the importer's token", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    await upload(token, { subject: "camper", file: new File(["x"], "x.csv") });
    batches = [{ batch: 1, rows: [{ rowRef: 9, personId: KID_C, status: "created", appFields: { invitedBy: "Pr. Davi" }, unfilled: [] }] }];
    const msg = batchMessage(1, []);
    delete (msg as Record<string, unknown>).rows;
    await deliver(msg, "d-big");
    await settle();
    expect(await findCamperById(KID_C)).toMatchObject({ invitedBy: "Pr. Davi" });
    expect(core.callsTo(`GET /imports/${IMPORT_ID}/batches`)[0].query.get("cursor")).toBe("1");
  });
});

describe("reconciliation (decision 64): the importer's read applies missed batches", () => {
  test("GET of a finished import reads every batch once and applies what is missing; rows already stamped stay untouched", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    await insertCamper(KID_B, { ...EMPTY_CAMPER, importId: IMPORT_ID, invitedBy: "edited after the import" });
    job = { ...job, status: "done" };
    batches = [{ batch: 0, rows: [
      { rowRef: 2, personId: KID_A, status: "created", appFields: { transportation: busId }, unfilled: [] },
      { rowRef: 3, personId: KID_B, status: "updated", appFields: { invitedBy: "old value" }, unfilled: [] },
    ] }];
    const res = await call("GET", `/api/imports/${IMPORT_ID}`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.import).toMatchObject({ id: IMPORT_ID, status: "done", subject: "camper", applied: { batches: 1, rows: 1 } });
    expect(await findCamperById(KID_A)).toMatchObject({ transportation: busId });
    expect(await findCamperById(KID_B)).toMatchObject({ invitedBy: "edited after the import" });
    await call("GET", `/api/imports/${IMPORT_ID}`, undefined, token);
    expect(core.callsTo(`GET /imports/${IMPORT_ID}/batches`)).toHaveLength(1);
  });

  test("results: batches pass through as ids + app fields", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    batches = [{ batch: 0, rows: [{ rowRef: 2, personId: KID_A, status: "created", appFields: { transportation: busId }, unfilled: ["team"] }] }];
    const res = await call("GET", `/api/imports/${IMPORT_ID}/results`, undefined, token);
    expect(res.body).toEqual({ items: [{ batch: 0, rows: [{ rowRef: "2", personId: KID_A, status: "created", reason: null, appFields: { transportation: busId }, unfilled: ["team"] }] }], nextCursor: null });
  });
});
