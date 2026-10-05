import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, json, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, TEST_ENV, TEST_PROJECT, type FakeCall, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { createApp } from "../app";
import { rawDb } from "../db";
import { insertBedroom } from "../models/bedrooms";
import { findCamperById, EMPTY_CAMPER, insertCamper } from "../models/campers";
import { createImportJob, findImportJob } from "../models/importJobs";
import { EMPTY_STAFF, findStaffById, insertStaff } from "../models/staff";
import { insertTeam } from "../models/teams";
import { insertTransport } from "../models/transports";
import { addClient, removeClient, type RealtimeClient } from "../services/realtime";
import { catchUpUnfinished } from "../services/personImports";
import { activeCampId, withCamp } from "../services/campContext";

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
const KID_C_REFUSED = "person-kid-c-refused";
const LEADER = "person-leader";
const SECRET = "whsec_test_secret_value";
/** persons-api import ids are Mongo ObjectIds */
const IMPORT_ID = "6700000000000000000000a1";
let busId: string;
let carId: string;
let roomId: string;
let bigRoomId: string;
let teamId: string;

/** the persons-api import job core keeps (rows never leave core — §20) */
let job: Record<string, unknown> | null;
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
  bigRoomId = (await insertBedroom({ name: "4", group: "girls", bunkBeds: 0, singleBeds: 10, notes: "" }))._id;
  teamId = (await insertTeam({ name: "Time Azul", color: "#1e6fd9", order: 0 }))._id;
  // exactly persons-api's GET /imports/:id (CONTRACTS §20, persons README)
  job = {
    id: IMPORT_ID,
    projectId: TEST_PROJECT,
    editionId: TEST_EDITION,
    status: "review",
    createdBy: ADMIN,
    createdVia: "role",
    targets: { camper: { role: "participante", responsibleRole: "responsavel" } },
    steps: [{ name: "read", done: 3, total: 3 }, { name: "columns", done: 1, total: 1 }, { name: "matching", done: 3, total: 3 }],
    file: { name: "inscricoes.xlsx", size: 1234, sheet: "Respostas" },
    mapping: { "Nome da criança": "name", "Ônibus": "app:transportation" },
    appFields: [],
    reviews: [
      { id: "match:4:person", kind: "match", blocking: true, options: ["match", "new", "skip"], rowRef: 4, who: "person", basis: "nameBirthDate", existingPersonId: KID_A, resolved: false, context: { name: "Ana Pequena" } },
      { id: "category:transportation:0", kind: "category", blocking: false, options: [busId, carId, "none"], field: "app:transportation", rowRefs: [2, 3], resolved: false, context: { value: "Ônibus azul" } },
      { id: "required:transportation", kind: "required", blocking: true, options: ["default", "skip"], field: "app:transportation", rowRefs: [5], resolved: false },
    ],
    counts: { rows: 3, pending: 2, batches: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  batches = [];
  core.on(`POST /projects/${TEST_PROJECT}/imports`, () => json({ importId: IMPORT_ID, status: "analysing" }, 201));
  core.on("GET /imports/:id", () => (job ? json(job) : json({ reason: "importNotFound" }, 404)));
  core.on("PATCH /imports/:id", () => json(job));
  core.on("POST /imports/:id/apply", () => {
    job = { ...job!, status: "applying" };
    return json({ importId: IMPORT_ID, status: "applying" }, 202);
  });
  core.on("DELETE /imports/:id", () => {
    job = { ...job!, status: "cancelled" };
    return json({ importId: IMPORT_ID, status: "cancelled" });
  });
  // persons-api semantics: cursor = the FIRST batch number; nextCursor = the next one, null when none exists yet
  core.on("GET /imports/:id/batches", (c: FakeCall) => {
    if (!job) return json({ reason: "importNotFound" }, 404);
    const cursor = Number(c.query.get("cursor") ?? 1);
    const limit = Number(c.query.get("limit") ?? 10);
    const sorted = [...batches].sort((a, b) => a.batch - b.batch).filter((b) => b.batch >= cursor);
    return json({ items: sorted.slice(0, limit), nextCursor: sorted[limit] ? String(sorted[limit].batch) : null });
  });
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
const settle = () => new Promise((r) => setTimeout(r, 60));

const batchMessage = (batch: number, rows: Record<string, unknown>[] | undefined, extra: Record<string, unknown> = {}) => ({
  id: `msg-${batch}`,
  type: "person-import.batch",
  importId: IMPORT_ID,
  projectId: TEST_PROJECT,
  step: "apply",
  done: batch,
  total: 3,
  status: "applying",
  batch,
  ...(rows ? { rows } : {}),
  ...extra,
});

const row = (rowRef: number, personId: string, appFields: Record<string, string>, extra: Record<string, unknown> = {}) => ({ rowRef, personId, status: "created", appFields, unfilled: [], ...extra });

function socketOf(personId: string, campId: string) {
  const sock = { sent: [] as string[], ws: { readyState: 1, send(s: string) { sock.sent.push(s); }, close() {} } };
  const client: RealtimeClient = { ws: sock.ws as never, role: "admin", coreRole: "coordenacao", personId, sessionId: `s-${personId}`, campId };
  addClient(client);
  return { events: () => sock.sent.map((x) => JSON.parse(x) as { type: string; data: Record<string, unknown> }), close: () => removeClient(client) };
}

/** An import this Acampa started (decision 77), as the upload route records it. */
async function started(lastBatch = 0, status = "applying") {
  await createImportJob({ importId: IMPORT_ID, campId: activeCampId(), startedBy: ADMIN, status });
  if (lastBatch) (await rawDb()).collection("importJobs").updateOne({ _id: IMPORT_ID as never }, { $set: { lastBatch } });
}

describe("app fields + targets (§20/§24)", () => {
  test("campers: vehicles / rooms / teams are categories keyed by Acampa ids; transportation is required", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/imports/app-fields?subject=camper", undefined, token);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.appFields.map((f: { key: string }) => [f.key, f]));
    expect(Object.keys(byKey)).toEqual(["transportation", "bedroom", "team", "bedroomPreference", "invitedBy", "generalNotes"]);
    expect(byKey.transportation).toMatchObject({ kind: "category", required: true });
    expect(byKey.transportation.categories).toEqual([{ key: busId, label: "Ônibus 1" }, { key: carId, label: "Carona: Carro do João" }]);
    expect(byKey.bedroom.categories).toEqual([{ key: roomId, label: "Quarto 3 (meninas)" }, { key: bigRoomId, label: "Quarto 4 (meninas)" }]);
    expect(byKey.generalNotes.description).toContain("NÃO são de saúde");
  });

  test("every field fits persons-api's limits (description ≤ 300, 1..200 categories, labels ≤ 120); a category with no option is not offered", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    for (const subject of ["camper", "team"]) {
      const res = await call("GET", `/api/imports/app-fields?subject=${subject}`, undefined, token);
      for (const f of res.body.appFields as { key: string; description: string; kind: string; categories?: { label: string }[] }[]) {
        expect(/^[A-Za-z0-9_-]{1,40}$/.test(f.key)).toBe(true);
        expect(f.description.length).toBeLessThanOrEqual(300);
        if (f.kind === "category") {
          expect(f.categories!.length).toBeGreaterThanOrEqual(1);
          for (const c of f.categories!) expect(c.label.length).toBeLessThanOrEqual(120);
        } else expect(f.categories).toBeUndefined();
      }
    }
    await (await rawDb()).collection("teams").deleteMany({});
    const res = await call("GET", "/api/imports/app-fields?subject=camper", undefined, token);
    expect(res.body.appFields.map((f: { key: string }) => f.key)).not.toContain("team");
  });

  test("team: roomRole is a required category", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("GET", "/api/imports/app-fields?subject=team", undefined, token);
    expect(res.body.appFields[0]).toMatchObject({ key: "roomRole", kind: "category", required: true });
    expect(res.body.appFields.map((f: { key: string }) => f.key)).not.toContain("invitedBy");
  });
});

describe("the proxy speaks persons-api §20 with the importer's coordenação token", () => {
  test("upload → multipart `file` + `data` JSON {editionId, targets {kind:{role, responsibleRole}}, appFields}; importJobs keeps ids only", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await upload(token, { subject: "camper", file: new File(["nome,onibus\nAna,azul\n"], "inscricoes.csv", { type: "text/csv" }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { import: Record<string, unknown> };
    expect(body.import).toMatchObject({ id: IMPORT_ID, subject: "camper", status: "review", counts: { rows: 3, pending: 2, batches: 0 }, applied: { batches: 0 } });
    const sent = core.callsTo(`POST /projects/${TEST_PROJECT}/imports`)[0];
    const bearer = (sent.headers.get("authorization") ?? "").slice(7);
    expect(JSON.parse(atob(bearer.split(".")[1]))).toMatchObject({ projectRole: "coordenacao", aud: "ipalpha:persons" });
    expect([...sent.multipart!.keys()].sort()).toEqual(["data", "file"]);
    const data = JSON.parse(String(sent.multipart!.get("data")));
    expect(Object.keys(data).sort()).toEqual(["appFields", "editionId", "targets"]);
    expect(data.editionId).toBe(TEST_EDITION);
    expect(data.targets).toEqual({ camper: { role: "participante", responsibleRole: "responsavel" } });
    expect(data.appFields.map((f: { key: string }) => f.key)).toContain("transportation");
    expect((sent.multipart!.get("file") as File).name).toBe("inscricoes.csv");
    const stored = await (await rawDb()).collection("importJobs").findOne({ _id: IMPORT_ID as never });
    expect(stored).toEqual({ _id: IMPORT_ID as never, campId: activeCampId(), startedBy: ADMIN, status: "analysing", lastBatch: 0 });
  });

  test("team upload: targets {team: {role: equipe}}", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    await upload(token, { subject: "team", file: new File(["x"], "equipe.xlsx") });
    expect(JSON.parse(String(core.callsTo(`POST /projects/${TEST_PROJECT}/imports`)[0].multipart!.get("data"))).targets).toEqual({ team: { role: "equipe" } });
  });

  test("an organizer without coordenação cannot import; bad files are refused before core", async () => {
    const org = await sessionFor(keys, ORGANIZER, ["organizacao"]);
    const res = await upload(org, { subject: "camper", file: new File(["a"], "a.csv") });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("COORDINATION_REQUIRED");
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect(((await (await upload(token, { subject: "camper", file: new File(["a"], "a.pdf") })).json()) as { error: { code: string } }).error.code).toBe("FILE_TYPE_INVALID");
    expect(((await (await upload(token, { subject: "camper", file: new File(["a"], "a.xls") })).json()) as { error: { code: string } }).error.code).toBe("FILE_TYPE_INVALID");
    expect(((await (await upload(token, { subject: "kids", file: new File(["a"], "a.csv") })).json()) as { error: { code: string } }).error.code).toBe("SUBJECT_INVALID");
    expect(((await (await upload(token, { subject: "camper", file: new File([new Uint8Array(5 * 1024 * 1024 + 1)], "a.csv") })).json()) as { error: { code: string } }).error.code).toBe("FILE_TOO_LARGE");
    expect(core.callsTo(`POST /projects/${TEST_PROJECT}/imports`)).toHaveLength(0);
  });

  test("the view: reviews with options + the importer's context, counts, failureReason, the fields a column may map to", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    job = { ...job!, status: "failed", failureReason: "membership:outsideWindow" };
    const res = await call("GET", `/api/imports/${IMPORT_ID}`, undefined, token);
    expect(res.status).toBe(200);
    const v = res.body.import;
    expect(v).toMatchObject({ status: "failed", failureReason: "membership:outsideWindow", counts: { rows: 3, pending: 2, batches: 0, created: 0, updated: 0, skipped: 0, failed: 0 } });
    expect(v.reviews[0]).toMatchObject({ id: "match:4:person", kind: "match", blocking: true, options: ["match", "new", "skip"], rowRef: 4, existingPersonId: KID_A, context: { name: "Ana Pequena" } });
    expect(v.reviews[1]).toMatchObject({ kind: "category", field: "app:transportation", rowRefs: [2, 3], context: { value: "Ônibus azul" } });
    expect(v.fields).toContain("responsible2Phone");
    expect(v.fields).toContain("app:transportation");
    expect(v.steps.map((s: { name: string }) => s.name)).toEqual(["read", "columns", "matching"]);
  });

  test("PATCH sends persons-api's own shape {mapping?, reviews:[{id, choice, value?, rows?}]}; Acampa's options and limits are checked first", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const bad = [
      { reviews: [{ id: "required:transportation", choice: "default", value: "not-a-vehicle" }] },
      { reviews: [{ id: "category:transportation:0", choice: "not-a-vehicle" }] },
      { reviews: [{ id: "category:invitedBy:0", choice: "x" }] },
      { reviews: [{ id: "required:transportation", rows: { "5": "not-a-vehicle" } }] },
      { reviews: { "match:4:person": { choice: "match" } } },
      { mapping: { "Nome da criança": "notAField" } },
      {},
    ];
    for (const body of bad) {
      const res = await call("PATCH", `/api/imports/${IMPORT_ID}`, body, token);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("DECISIONS_INVALID");
    }
    expect(core.callsTo(`PATCH /imports/${IMPORT_ID}`)).toHaveLength(0);
    const decisions = {
      mapping: { "Ônibus": "app:transportation", Obs: null },
      reviews: [
        { id: "match:4:person", choice: "match" },
        { id: "category:transportation:0", choice: busId },
        { id: "required:transportation", choice: "default", value: carId, rows: { "5": "skip" } },
        { id: "invalid:7:birthDate", choice: "value", value: "02/03/2016" },
      ],
    };
    const ok = await call("PATCH", `/api/imports/${IMPORT_ID}`, decisions, token);
    expect(ok.status).toBe(200);
    expect(core.callsTo(`PATCH /imports/${IMPORT_ID}`)[0].json).toEqual(decisions);
  });

  test("apply sends only the coordenação PERSONS token (persons-api enrolls with its own system scope — decision 75); decisionsPending comes back with its pending list", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await call("POST", `/api/imports/${IMPORT_ID}/apply`, {}, token);
    expect(res.status).toBe(200);
    expect(res.body.import.status).toBe("applying");
    const sent = core.callsTo(`POST /imports/${IMPORT_ID}/apply`)[0];
    expect(sent.headers.get("x-projects-authorization")).toBeNull();
    expect(JSON.parse(atob((sent.headers.get("authorization") ?? "").slice(7).split(".")[1]))).toMatchObject({ projectRole: "coordenacao", aud: "ipalpha:persons" });

    core.on("POST /imports/:id/apply", () => json({ reason: "decisionsPending", pending: [{ id: "required:transportation", kind: "required", field: "app:transportation" }, { id: "match:4:person", kind: "match" }] }, 409));
    const refused = await call("POST", `/api/imports/${IMPORT_ID}/apply`, {}, token);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "DECISIONS_PENDING", pending: [{ id: "required:transportation", kind: "required", field: "app:transportation" }, { id: "match:4:person", kind: "match" }] });
  });

  test("results: cursor is a batch number; batches pass through as ids + app fields", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    batches = [{ batch: 1, rows: [{ rowRef: 2, personId: KID_A, status: "created", appFields: { transportation: busId }, unfilled: ["team"] }] }, { batch: 2, rows: [] }];
    const res = await call("GET", `/api/imports/${IMPORT_ID}/results?cursor=2`, undefined, token);
    expect(res.body).toEqual({ items: [{ batch: 2, rows: [] }], nextCursor: null });
    expect(core.callsTo(`GET /imports/${IMPORT_ID}/batches`)[0].query.get("cursor")).toBe("2");
    const first = await call("GET", `/api/imports/${IMPORT_ID}/results`, undefined, token);
    expect(first.body.items[0]).toEqual({ batch: 1, rows: [{ rowRef: "2", personId: KID_A, status: "created", reason: null, appFields: { transportation: busId }, unfilled: ["team"] }] });
    expect((await call("GET", `/api/imports/${IMPORT_ID}/results?cursor=abc`, undefined, token)).status).toBe(400);
  });
});

describe("webhook (§21/§22): HMAC, idempotent, batches → participants", () => {
  test("a wrong / missing signature is refused; no secret configured = 503", async () => {
    const msg = batchMessage(1, []);
    expect((await deliver(msg, "d-1", signed(JSON.stringify(msg), "other-secret"))).status).toBe(401);
    expect((await deliver(msg, "d-1", "sha256=zz")).status).toBe(401);
    enableIpalpha(core, keys, TEST_ENV);
    expect((await deliver(msg, "d-1")).status).toBe(503);
  });

  test("the next batch fills the kids' camp ops by personId; categories are checked; lastBatch moves; a duplicate changes nothing", async () => {
    await sessionFor(keys, ADMIN, ["coordenacao"]);
    await started();
    const sock = socketOf(ADMIN, activeCampId());
    const rows = [
      row(2, KID_A, { transportation: busId, bedroom: roomId, team: teamId, invitedBy: "Tia Bia", generalNotes: "gosta de desenhar" }),
      row(3, KID_B, { transportation: "unknown-bus", bedroom: roomId }, { status: "updated", unfilled: ["team"] }),
      { rowRef: 4, status: "failed", reason: "cannotLinkSelf", appFields: {}, unfilled: [] },
      // an existing person whose membership projects-api refused (decision 81): data kept in core, no camp row here
      { rowRef: 5, personId: KID_C_REFUSED, status: "failed", reason: "membership:conflict", appFields: { transportation: busId }, unfilled: [] },
    ];
    expect((await deliver(batchMessage(1, rows), "d-batch-1")).status).toBe(202);
    await settle();
    const a = await findCamperById(KID_A);
    expect(a).toMatchObject({ transportation: busId, bedroom: roomId, team: teamId, invitedBy: "Tia Bia", generalNotes: "gosta de desenhar", importId: IMPORT_ID, importEdited: [] });
    expect(a!.qrToken).not.toBe("");
    // the room has one bed: the second kid does not overfill it; the unknown vehicle is not written
    expect(await findCamperById(KID_B)).toMatchObject({ transportation: null, bedroom: null, importId: IMPORT_ID });
    expect((await findImportJob(IMPORT_ID))!.lastBatch).toBe(1);
    const event = sock.events().find((e) => e.type === "import-batch")!;
    expect(await findCamperById(KID_C_REFUSED)).toBeNull();
    expect(event.data).toEqual({ importId: IMPORT_ID, batch: 1, rows: 4, applied: 2, skipped: 2, unfilled: 3, conflicts: 0 });
    expect(JSON.stringify(sock.events().filter((e) => e.type.startsWith("import-")))).not.toContain("Tia Bia");
    expect((await deliver(batchMessage(1, rows), "d-batch-1")).body).toEqual({ ok: true, duplicate: true });
    // the same batch under another delivery id (socket + webhook) is not applied twice either
    await deliver(batchMessage(1, rows, { id: "other" }), "d-batch-1b");
    await settle();
    expect((await findImportJob(IMPORT_ID))!.lastBatch).toBe(1);
    sock.close();
  });

  test("progress reaches only the importer's sockets (ids + counts); the job keeps persons-api's status", async () => {
    await started(0, "analysing");
    const campId = activeCampId();
    const mine = socketOf(ADMIN, campId);
    const other = socketOf("someone-else", campId);
    await deliver({ id: "p-1", type: "person-import.progress", importId: IMPORT_ID, projectId: TEST_PROJECT, step: "observations", done: 5, total: 10, status: "analysing" }, "d-p-1");
    await deliver({ id: "p-2", type: "person-import.progress", importId: IMPORT_ID, projectId: TEST_PROJECT, step: "observations", done: 10, total: 10, status: "review" }, "d-p-2");
    await settle();
    expect(mine.events()).toContainEqual(expect.objectContaining({ type: "import-progress", data: { importId: IMPORT_ID, step: "observations", done: 5, total: 10, status: "analysing" } }));
    expect(other.events()).toHaveLength(0);
    expect((await findImportJob(IMPORT_ID))!.status).toBe("review");
    mine.close();
    other.close();
  });

  test("an import nobody here started (Mordomia): kid or team comes from the live edition role", async () => {
    await deliver(batchMessage(1, [row(1, KID_C, { transportation: carId }), row(2, LEADER, { roomRole: "caretaker" })]), "d-x");
    await settle();
    expect(await findCamperById(KID_C)).toMatchObject({ transportation: carId });
    expect(await findStaffById(LEADER)).toMatchObject({ roomRole: "caretaker" });
    expect(await findImportJob(IMPORT_ID)).toBeNull();
  });

  test("a batch too big for dispatch (no rows) is read from persons-api with the importer's live session token", async () => {
    await sessionFor(keys, ADMIN, ["coordenacao"]);
    await started();
    batches = [{ batch: 1, rows: [row(9, KID_C, { invitedBy: "Pr. Davi" })] }];
    await deliver(batchMessage(1, undefined), "d-big");
    await settle();
    expect(await findCamperById(KID_C)).toMatchObject({ invitedBy: "Pr. Davi" });
    const read = core.callsTo(`GET /imports/${IMPORT_ID}/batches`)[0];
    expect(read.query.get("cursor")).toBe("1");
    expect(JSON.parse(atob((read.headers.get("authorization") ?? "").slice(7).split(".")[1]))).toMatchObject({ sub: ADMIN, projectRole: "coordenacao" });
  });

  test("a batch out of order (2 lost, 3 arrives): the gap is read from persons-api first, in order", async () => {
    await sessionFor(keys, ADMIN, ["coordenacao"]);
    await started(1);
    batches = [{ batch: 1, rows: [] }, { batch: 2, rows: [row(5, KID_A, { transportation: busId })] }, { batch: 3, rows: [row(6, KID_B, { transportation: carId })] }];
    await deliver(batchMessage(3, batches[2].rows), "d-3");
    await settle();
    expect(core.callsTo(`GET /imports/${IMPORT_ID}/batches`)[0].query.get("cursor")).toBe("2");
    expect(await findCamperById(KID_A)).toMatchObject({ transportation: busId });
    expect(await findCamperById(KID_B)).toMatchObject({ transportation: carId });
    expect((await findImportJob(IMPORT_ID))!.lastBatch).toBe(3);
  });
});

describe("decision 77: unfinished imports are caught up (boot, reconnect, the importer's reads)", () => {
  test("boot / reconnect: every batch after lastBatch is read page by page (cursor = next batch number) and the entry ends with persons-api's final status", async () => {
    await sessionFor(keys, ADMIN, ["coordenacao"]);
    await started(1);
    job = { ...job!, status: "done" };
    batches = Array.from({ length: 12 }, (_, i) => ({ batch: i + 1, rows: i === 11 ? [row(40, KID_C, { transportation: carId })] : [] }));
    expect(await catchUpUnfinished()).toBe(1);
    const reads = core.callsTo(`GET /imports/${IMPORT_ID}/batches`).map((c) => c.query.get("cursor"));
    expect(reads).toEqual(["2", "12"]);
    expect(await findImportJob(IMPORT_ID)).toMatchObject({ status: "done", lastBatch: 12 });
    expect(await findCamperById(KID_C)).toMatchObject({ transportation: carId });
    // finished: the next boot reads nothing
    await catchUpUnfinished();
    expect(core.callsTo(`GET /imports/${IMPORT_ID}/batches`)).toHaveLength(2);
  });

  test("still applying: what exists is applied, the entry stays open for the next pass", async () => {
    await sessionFor(keys, ADMIN, ["coordenacao"]);
    await started();
    job = { ...job!, status: "applying" };
    batches = [{ batch: 1, rows: [row(2, KID_A, { team: teamId })] }];
    await catchUpUnfinished();
    expect(await findImportJob(IMPORT_ID)).toMatchObject({ status: "applying", lastBatch: 1 });
  });

  test("the importer has no live session: nothing is read, the entry waits; an import persons-api dropped (404) ends the entry", async () => {
    await started();
    expect(await catchUpUnfinished()).toBe(0);
    expect(core.callsTo(`GET /imports/${IMPORT_ID}`)).toHaveLength(0);
    expect(await findImportJob(IMPORT_ID)).toMatchObject({ status: "applying", lastBatch: 0 });
    await sessionFor(keys, ADMIN, ["coordenacao"]);
    job = null;
    await catchUpUnfinished();
    expect(await findImportJob(IMPORT_ID)).toBeNull();
  });

  test("the importer's GET catches up when persons-api has more batches than were applied here", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    await started();
    job = { ...job!, status: "done", counts: { ...(job!.counts as object), batches: 1 } };
    batches = [{ batch: 1, rows: [row(2, KID_A, { transportation: busId })] }];
    const res = await call("GET", `/api/imports/${IMPORT_ID}`, undefined, token);
    expect(res.body.import).toMatchObject({ status: "done", subject: "camper", applied: { batches: 1 } });
    expect(await findCamperById(KID_A)).toMatchObject({ transportation: busId });
    await call("GET", `/api/imports/${IMPORT_ID}`, undefined, token);
    expect(core.callsTo(`GET /imports/${IMPORT_ID}/batches`)).toHaveLength(1);
  });

  test("cancel: batches applied before it are still read, then the entry ends", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    await started();
    batches = [{ batch: 1, rows: [row(2, KID_B, { transportation: carId })] }];
    expect((await call("DELETE", `/api/imports/${IMPORT_ID}`, undefined, token)).body).toEqual({ success: true });
    expect(await findCamperById(KID_B)).toMatchObject({ transportation: carId });
    expect(await findImportJob(IMPORT_ID)).toMatchObject({ status: "cancelled", lastBatch: 1 });
  });
});

describe("decision 78: a field changed by hand is never overwritten by an import", () => {
  async function kidEditedByHand() {
    await withCamp(activeCampId(), async () => {
      await insertCamper(KID_A, { ...EMPTY_CAMPER, transportation: busId, team: teamId, generalNotes: "chega sábado" }, "import");
    });
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    // a person moves the kid to the car by hand
    const res = await call("PUT", `/api/campers/${KID_A}`, { transportation: carId }, token);
    expect(res.status).toBe(200);
    expect((await findCamperById(KID_A))!.importEdited).toEqual(["transportation"]);
    return token;
  }

  test("a different import value becomes an open decision (ids + values only); fields nobody touched are updated; an equal value is no conflict", async () => {
    const token = await kidEditedByHand();
    await started();
    await deliver(batchMessage(1, [row(2, KID_A, { transportation: busId, team: teamId, generalNotes: "gosta de desenhar" }, { status: "updated" })]), "d-c1");
    await settle();
    const kid = await findCamperById(KID_A);
    expect(kid).toMatchObject({ transportation: carId, generalNotes: "gosta de desenhar", importId: IMPORT_ID, importEdited: ["transportation"] });
    const stored = await (await rawDb()).collection("importConflicts").find({}).toArray();
    expect(stored).toHaveLength(1);
    const { _id, createdAt, ...rest } = stored[0];
    expect(rest).toEqual({ campId: activeCampId(), personId: KID_A, field: "transportation", kind: "camper", importId: IMPORT_ID, importValue: busId, currentValue: carId });
    const list = await call("GET", "/api/import-conflicts?subject=camper", undefined, token);
    expect(list.body.items).toEqual([{ id: String(_id), personId: KID_A, field: "transportation", importValue: busId, currentValue: carId, importId: IMPORT_ID, createdAt: expect.any(String) }]);
    expect((await call("GET", "/api/import-conflicts?subject=team", undefined, token)).body.items).toEqual([]);
  });

  test("“Aplicar valor da importação” writes it and forgets the manual mark; “Manter o atual” keeps it (and the next import asks again)", async () => {
    const token = await kidEditedByHand();
    await started();
    await deliver(batchMessage(1, [row(2, KID_A, { transportation: busId, generalNotes: "nota nova" }, { status: "updated" })]), "d-c2");
    await settle();
    await call("PUT", `/api/campers/${KID_A}`, { generalNotes: "nota da coordenação" }, token);
    // a second import (another id) brings both fields again
    const SECOND = "6700000000000000000000b2";
    await deliver({ ...batchMessage(1, [row(2, KID_A, { transportation: busId, generalNotes: "nota nova 2" }, { status: "updated" })]), importId: SECOND, id: "m-2" }, "d-c3");
    await settle();
    const items = (await call("GET", "/api/import-conflicts?subject=camper", undefined, token)).body.items as { id: string; field: string }[];
    expect(items.map((i) => i.field).sort()).toEqual(["generalNotes", "transportation"]);
    const notes = items.find((i) => i.field === "generalNotes")!;
    const transport = items.find((i) => i.field === "transportation")!;
    const kept = await call("POST", "/api/import-conflicts/resolve", { ids: [notes.id], choice: "keep" }, token);
    expect(kept.body).toEqual({ applied: 0, kept: 1, failed: [] });
    expect(await findCamperById(KID_A)).toMatchObject({ generalNotes: "nota da coordenação" });
    const applied = await call("POST", "/api/import-conflicts/resolve", { ids: [transport.id], choice: "import" }, token);
    expect(applied.body).toEqual({ applied: 1, kept: 0, failed: [] });
    const kid = await findCamperById(KID_A);
    expect(kid).toMatchObject({ transportation: busId });
    expect(kid!.importEdited).toEqual(["generalNotes"]);
    expect((await call("GET", "/api/import-conflicts?subject=camper", undefined, token)).body.items).toEqual([]);
    // the kept note is still a manual choice: a third import asks again
    await deliver({ ...batchMessage(2, [row(2, KID_A, { generalNotes: "nota nova 3" }, { status: "updated" })]), importId: "6700000000000000000000c3", id: "m-3" }, "d-c4");
    await settle();
    expect((await call("GET", "/api/import-conflicts?subject=camper", undefined, token)).body.items.map((i: { field: string }) => i.field)).toEqual(["generalNotes"]);
  });

  test("team: a room role set by hand is asked on the team page; a full room cannot be applied", async () => {
    await withCamp(activeCampId(), async () => {
      await insertStaff(LEADER, { ...EMPTY_STAFF, roomRole: "caretaker" });
      await insertCamper(KID_B, { ...EMPTY_CAMPER, bedroom: roomId }, "import");
    });
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    await deliver(batchMessage(1, [row(3, LEADER, { roomRole: "helper", bedroom: roomId }, { status: "updated" })]), "d-t1");
    await settle();
    // roomRole was set by hand (manual insert) → conflict; bedroom was never touched by hand → written, but the room is full → unfilled
    const staff = await findStaffById(LEADER);
    expect(staff).toMatchObject({ roomRole: "caretaker", bedroom: null });
    const items = (await call("GET", "/api/import-conflicts?subject=team", undefined, token)).body.items;
    expect(items).toEqual([expect.objectContaining({ personId: LEADER, field: "roomRole", importValue: "helper", currentValue: "caretaker" })]);
    // a room conflict whose room filled up meanwhile is refused gently
    await call("PUT", `/api/staff/${LEADER}`, { bedroom: bigRoomId }, token);
    await (await rawDb()).collection("importConflicts").insertOne({ campId: activeCampId(), personId: LEADER, kind: "team", field: "bedroom", importId: IMPORT_ID, importValue: roomId, currentValue: bigRoomId, createdAt: new Date() });
    const bedroom = (await call("GET", "/api/import-conflicts?subject=team", undefined, token)).body.items.find((i: { field: string }) => i.field === "bedroom");
    const res = await call("POST", "/api/import-conflicts/resolve", { ids: [bedroom.id], choice: "import" }, token);
    expect(res.body).toMatchObject({ applied: 0, failed: [{ id: bedroom.id, code: "BEDROOM_FULL" }] });
    expect(await findStaffById(LEADER)).toMatchObject({ bedroom: bigRoomId });
  });

  test("only the organização decides; bad bodies are refused", async () => {
    world.memberships.push({ personId: "person-care", role: "saude", editionId: TEST_EDITION });
    const care = await sessionFor(keys, "person-care", ["saude"]);
    expect((await call("GET", "/api/import-conflicts?subject=camper", undefined, care)).status).toBe(403);
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await call("GET", "/api/import-conflicts?subject=kids", undefined, token)).status).toBe(400);
    expect((await call("POST", "/api/import-conflicts/resolve", { ids: [], choice: "keep" }, token)).body.error.code).toBe("IDS_INVALID");
    expect((await call("POST", "/api/import-conflicts/resolve", { ids: ["x"], choice: "maybe" }, token)).body.error.code).toBe("CHOICE_INVALID");
  });
});
