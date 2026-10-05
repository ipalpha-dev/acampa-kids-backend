import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";

const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ADMIN = "person-admin";
const ORGANIZER = "person-organizer";
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
  for (const [id, name] of [[ADMIN, "Coordenadora Teste"], [PARENT, "Família Teste"], [OTHER_PARENT, "Outra Família"], [KID_A, "Ana Pequena"], [KID_B, "Bruno Pequeno"]]) world.names.set(id, name);
  world.memberships.push(
    { personId: ADMIN, role: "coordenacao" },
    { personId: ORGANIZER, role: "organizacao", editionId: TEST_EDITION },
    { personId: PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: OTHER_PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: KID_A, role: "participante", editionId: TEST_EDITION, involved: [{ personId: PARENT, purpose: "responsible" }] },
    { personId: KID_B, role: "participante", editionId: TEST_EDITION, involved: [{ personId: OTHER_PARENT, purpose: "responsible" }] },
  );
  world.links.push({ subjectId: KID_A, agentId: PARENT }, { subjectId: KID_B, agentId: OTHER_PARENT });
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  await insertCamper(KID_A, { ...EMPTY_CAMPER });
  await insertCamper(KID_B, { ...EMPTY_CAMPER });
});

async function propose(token: string, body: Record<string, unknown> = { camperId: KID_A, name: "marta souza", phone: "11977776666" }) {
  return call("POST", "/api/link-requests", body, token);
}

describe("link requests (decision 80, CONTRACTS §25)", () => {
  test("the coordenação proposes: the person is registered WITHOUT a child (no link) and WITHOUT a membership, then the request goes to persons-api", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const res = await propose(token);
    expect(res.status).toBe(201);
    const proposedId = res.body.responsible.personId;
    expect(res.body).toMatchObject({ request: { childId: KID_A, status: "pending" }, responsible: { created: true } });
    const reg = core.callsTo("POST /registrations")[0].json as Record<string, unknown>;
    expect(reg).toMatchObject({ role: "responsavel", people: [{ name: "Marta Souza", phone: "+5511977776666" }] });
    expect(reg.children).toBeUndefined();
    expect(reg.responsible).toBeUndefined();
    // nothing linked or shared yet
    expect(world.links.some((l) => l.agentId === proposedId)).toBe(false);
    expect(core.callsTo("POST /links")).toHaveLength(0);
    expect(world.memberships.some((m) => m.personId === proposedId)).toBe(false);
    const sent = core.callsTo("POST /projects/project-test-1/link-requests")[0];
    expect(sent.json).toEqual({ childId: KID_A, responsibleId: proposedId });
    expect(JSON.parse(atob((sent.headers.get("authorization") ?? "").slice(7).split(".")[1]))).toMatchObject({ projectRole: "coordenacao", aud: "ipalpha:persons" });
    // Acampa keeps nothing about it (ids live in persons-api; never a name here)
    const db = await rawDb();
    for (const name of await db.listCollections().toArray()) {
      const docs = await db.collection(name.name).find({}).toArray();
      expect(JSON.stringify(docs)).not.toContain("Marta");
    }
  });

  test("an existing person (same phone) is found, not duplicated; a second proposal answers requestPending; an already-linked person answers alreadyLinked", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    world.phones.set("+5511977776666", OTHER_PARENT);
    const first = await propose(token);
    expect(first.body.responsible).toEqual({ personId: OTHER_PARENT, created: false });
    const again = await propose(token);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "LINK_REQUEST_REFUSED", reason: "requestPending" });
    world.phones.set("+5511955554444", PARENT);
    const linked = await propose(token, { camperId: KID_A, name: "Família Teste", phone: "11955554444" });
    expect(linked.status).toBe(409);
    expect(linked.body.error.reason).toBe("alreadyLinked");
  });

  test("bad bodies are refused before core; only the coordenação proposes; parents cannot", async () => {
    const token = await sessionFor(keys, ADMIN, ["coordenacao"]);
    expect((await propose(token, { camperId: KID_A, name: "", phone: "11977776666" })).body.error.code).toBe("RESPONSIBLE_INVALID");
    expect((await propose(token, { camperId: KID_A, name: "Marta", phone: "123" })).body.error.code).toBe("RESPONSIBLE_INVALID");
    expect((await propose(token, { camperId: KID_A, name: "Marta", phone: "11977776666", email: "not-an-email" })).body.error.code).toBe("EMAIL_INVALID");
    const missing = await propose(token, { camperId: "nobody", name: "Marta", phone: "11977776666" });
    expect(missing.status).toBe(404);
    const org = await sessionFor(keys, ORGANIZER, ["organizacao"]);
    const byOrg = await propose(org);
    expect(byOrg.status).toBe(403);
    expect(byOrg.body.error.code).toBe("COORDINATION_REQUIRED");
    const parent = await sessionFor(keys, PARENT, ["responsavel"]);
    expect((await propose(parent)).status).toBe(403);
    expect(core.callsTo("POST /registrations")).toHaveLength(0);
    expect(core.callsTo("POST /projects/project-test-1/link-requests")).toHaveLength(0);
  });

  test("the family sees the pending request for THEIR kid with their responsável token, and accepts: the link is created in persons-api", async () => {
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const proposedId = (await propose(admin)).body.responsible.personId;
    const parent = await sessionFor(keys, PARENT, ["responsavel"]);
    const mine = await call("GET", "/api/link-requests/mine", undefined, parent);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ childId: KID_A, proposedResponsibleId: proposedId, status: "pending", child: { name: "Ana Pequena" }, proposedResponsible: { name: "Marta Souza" }, projectName: "Acampa Kids" });
    const read = core.callsTo("GET /me/link-requests")[0];
    expect(JSON.parse(atob((read.headers.get("authorization") ?? "").slice(7).split(".")[1]))).toMatchObject({ sub: PARENT, projectRole: "responsavel", aud: "ipalpha:persons" });
    // another family sees nothing of it
    const other = await sessionFor(keys, OTHER_PARENT, ["responsavel"]);
    expect((await call("GET", "/api/link-requests/mine", undefined, other)).body.items).toEqual([]);

    const id = mine.body.items[0].id;
    const accepted = await call("POST", `/api/link-requests/${id}/accept`, {}, parent);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ request: { id, childId: KID_A, status: "accepted" } });
    expect(world.links).toContainEqual({ subjectId: KID_A, agentId: proposedId });
    expect((await call("GET", "/api/link-requests/mine", undefined, parent)).body.items).toEqual([]);
    // decided once: a second answer is core's 409
    const twice = await call("POST", `/api/link-requests/${id}/decline`, {}, parent);
    expect(twice.status).toBe(409);
    expect(twice.body.error.reason).toBe("requestNotPending");
  });

  test("decline links nothing; someone who is not the kid's responsável is refused by core; staff cannot reach the family routes", async () => {
    const admin = await sessionFor(keys, ADMIN, ["coordenacao"]);
    const proposedId = (await propose(admin)).body.responsible.personId;
    const other = await sessionFor(keys, OTHER_PARENT, ["responsavel"]);
    const notMine = await call("POST", "/api/link-requests/lr-1/accept", {}, other);
    expect(notMine.status).toBe(403);
    expect(notMine.body.error.reason).toBe("notResponsible");
    expect((await call("GET", "/api/link-requests/mine", undefined, admin)).status).toBe(403);
    expect((await call("POST", "/api/link-requests/lr-1/accept", {}, admin)).status).toBe(403);
    const parent = await sessionFor(keys, PARENT, ["responsavel"]);
    const declined = await call("POST", "/api/link-requests/lr-1/decline", {}, parent);
    expect(declined.body.request.status).toBe("declined");
    expect(world.links.some((l) => l.agentId === proposedId)).toBe(false);
  });

  test("a revoked responsável token ends the session (never retried)", async () => {
    const parent = await sessionFor(keys, PARENT, ["responsavel"]);
    core.on("GET /me/link-requests", () => new Response(JSON.stringify({ reason: "invalidToken" }), { status: 401, headers: { "content-type": "application/json" } }));
    const res = await call("GET", "/api/link-requests/mine", undefined, parent);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_ENDED");
  });
});
