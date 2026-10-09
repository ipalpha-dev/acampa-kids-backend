import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, json, resetData, sessionFor, startTestDb, stopTestDb, testApp, TEST_EDITION, TEST_PROJECT, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";
import { kidsOfResponsible } from "../services/members";
import { findSessionByToken } from "../services/session";
import { withViewer } from "../services/viewer";

const call = testApp();
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ORGANIZER = "person-organizer";
const PARENT = "person-parent";
/** joined KID_A through an accepted link request (decision 86): involved with EMPTY kinds, nothing of theirs shared yet */
const NEW_PARENT = "person-new-parent";
const KID_A = "person-kid-a";
const KID_B = "person-kid-b";
const PENDING = `/projects/${TEST_PROJECT}/me/pending-kinds`;

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
    { personId: ORGANIZER, role: "organizacao", editionId: TEST_EDITION },
    { personId: PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: NEW_PARENT, role: "responsavel", editionId: TEST_EDITION },
    { personId: KID_A, role: "participante", editionId: TEST_EDITION, involved: [{ personId: PARENT, purpose: "responsible" }] },
    { personId: KID_B, role: "participante", editionId: TEST_EDITION, involved: [{ personId: NEW_PARENT, purpose: "responsible" }] },
  );
  world.pendingKinds.set(NEW_PARENT, [
    { membershipId: "m-kid-a", kind: "involved", personId: KID_A, role: "participante", editionId: TEST_EDITION, granted: [], requested: ["phone", "email"] },
    { membershipId: "m-new-parent", kind: "own", personId: NEW_PARENT, role: "responsavel", editionId: TEST_EDITION, granted: [], requested: ["emergencyContact"] },
  ]);
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  await insertCamper(KID_A, { ...EMPTY_CAMPER });
  await insertCamper(KID_B, { ...EMPTY_CAMPER });
});

/** what projects-api does on linkRequest.accepted: the new responsible joins the kid's membership (empty kinds) */
function acceptLinkInCore() {
  const kid = world.memberships.find((m) => m.personId === KID_A)!;
  kid.involved = [...(kid.involved ?? []), { personId: NEW_PARENT, purpose: "responsible" }];
}

const claims = (path: string) => JSON.parse(atob((core.callsTo(path)[0].headers.get("authorization") ?? "").slice(7).split(".")[1]));

describe("pending kinds (decision 87)", () => {
  test("after the acceptance the new responsável sees the kid at once (empty kinds are not filtered; the 20 s memo is refreshed)", async () => {
    const token = await sessionFor(keys, NEW_PARENT, ["responsavel"]);
    const session = (await findSessionByToken(token))!;
    const kids = () => withViewer(session, () => kidsOfResponsible(NEW_PARENT));
    // already signed in for KID_B: the memo holds [KID_B]
    expect(await kids()).toEqual([KID_B]);
    acceptLinkInCore();
    expect(await kids()).toEqual([KID_B]);
    const pending = await call("GET", "/api/pending-kinds", undefined, token);
    expect(pending.status).toBe(200);
    expect((await kids()).sort()).toEqual([KID_A, KID_B]);
    const list = await call("GET", "/api/campers", undefined, token);
    expect(list.body.items.map((k: { id: string }) => k.id).sort()).toEqual([KID_A, KID_B]);
  });

  test("GET forwards to projects-api with the family's OWN responsável projects token and the camp's edition", async () => {
    const token = await sessionFor(keys, NEW_PARENT, ["responsavel"]);
    const res = await call("GET", "/api/pending-kinds", undefined, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      editionId: TEST_EDITION,
      items: [
        { membershipId: "m-kid-a", kind: "involved", personId: KID_A, role: "participante", editionId: TEST_EDITION, granted: [], requested: ["phone", "email"] },
        { membershipId: "m-new-parent", kind: "own", personId: NEW_PARENT, role: "responsavel", editionId: TEST_EDITION, granted: [], requested: ["emergencyContact"] },
      ],
      kinds: ["email", "emergencyContact", "phone"],
    });
    expect(core.callsTo(`GET ${PENDING}`)[0].query.get("editionId")).toBe(TEST_EDITION);
    expect(claims(`GET ${PENDING}`)).toMatchObject({ sub: NEW_PARENT, projectRole: "responsavel", aud: "ipalpha:projects" });
  });

  test("confirm sends exactly the shown kinds (a set) and the edition; afterwards nothing is pending", async () => {
    const token = await sessionFor(keys, NEW_PARENT, ["responsavel"]);
    const res = await call("POST", "/api/pending-kinds/confirm", { kinds: ["phone", "emergencyContact", "email", "phone"] }, token);
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(2);
    expect(res.body.items[0].granted).toEqual(["phone", "email"]);
    const sent = core.callsTo(`POST ${PENDING}/confirm`)[0];
    expect(sent.json).toEqual({ kinds: ["phone", "emergencyContact", "email"], editionId: TEST_EDITION });
    expect(claims(`POST ${PENDING}/confirm`)).toMatchObject({ sub: NEW_PARENT, projectRole: "responsavel", aud: "ipalpha:projects" });
    expect((await call("GET", "/api/pending-kinds", undefined, token)).body).toEqual({ editionId: TEST_EDITION, items: [], kinds: [] });
  });

  test("409 pendingChanged passes through with the NEW kinds; nothing is confirmed", async () => {
    const token = await sessionFor(keys, NEW_PARENT, ["responsavel"]);
    const res = await call("POST", "/api/pending-kinds/confirm", { kinds: ["phone", "email"] }, token);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "PENDING_CHANGED", reason: "pendingChanged", kinds: ["email", "emergencyContact", "phone"] });
    expect(world.pendingKinds.get(NEW_PARENT)).toHaveLength(2);
  });

  test("nothing pending: GET answers an empty list, confirm answers 200 confirmed 0 (idempotent)", async () => {
    const token = await sessionFor(keys, PARENT, ["responsavel"]);
    expect((await call("GET", "/api/pending-kinds", undefined, token)).body).toEqual({ editionId: TEST_EDITION, items: [], kinds: [] });
    const res = await call("POST", "/api/pending-kinds/confirm", { kinds: [] }, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], kinds: [], confirmed: 0 });
  });

  test("only a responsável session reaches it; bad kinds are refused before core", async () => {
    const org = await sessionFor(keys, ORGANIZER, ["organizacao"]);
    const asStaff = await call("GET", "/api/pending-kinds", undefined, org);
    expect(asStaff.status).toBe(403);
    expect(asStaff.body.error.code).toBe("FORBIDDEN");
    expect((await call("POST", "/api/pending-kinds/confirm", { kinds: ["phone"] }, org)).status).toBe(403);
    expect((await call("GET", "/api/pending-kinds")).status).toBe(401);
    const token = await sessionFor(keys, NEW_PARENT, ["responsavel"]);
    for (const body of [{}, { kinds: "phone" }, { kinds: ["phone", "shoeSize"] }]) {
      const bad = await call("POST", "/api/pending-kinds/confirm", body, token);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("KINDS_INVALID");
    }
    expect(core.callsTo(`POST ${PENDING}/confirm`)).toHaveLength(0);
    // the role check is remembered ~15 s: staff once, responsável once (the bad bodies never reach core)
    expect(core.callsTo(`GET ${PENDING}`)).toHaveLength(2);
  });

  test("core refusals keep their reason; a revoked responsável token ends the session", async () => {
    const token = await sessionFor(keys, NEW_PARENT, ["responsavel"]);
    core.on(`GET ${PENDING}`, () => json({ reason: "noGrant" }, 403));
    const refused = await call("GET", "/api/pending-kinds", undefined, token);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "CORE_FORBIDDEN", reason: "noGrant" });
    core.on(`GET ${PENDING}`, () => json({ items: [], kinds: [] }));
    core.on(`POST ${PENDING}/confirm`, () => json({ reason: "invalidToken" }, 401));
    const revoked = await call("POST", "/api/pending-kinds/confirm", { kinds: ["phone"] }, token);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe("SESSION_ENDED");
  });

  test("Acampa unlinked from the project (appMismatch) is final: the session ends like a revoke", async () => {
    const token = await sessionFor(keys, NEW_PARENT, ["responsavel"]);
    core.on(`GET ${PENDING}`, () => json({ reason: "appMismatch" }, 403));
    const res = await call("GET", "/api/pending-kinds", undefined, token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_ENDED");
    expect((await call("GET", "/api/auth/me", undefined, token)).status).toBe(401);
  });
});
