import { beforeAll, describe, expect, test } from "bun:test";
import { readIpalphaConfig } from "../../config";
import { createFakeCore, createTestKeys, json, tokenAnswer, TEST_ENV, TEST_EDITION, type TestKeys } from "../../testing/ipalphaHarness";
import { createIpalphaCoreClient, IpalphaRejected, IpalphaTokenRevoked, IpalphaUnavailable } from "./coreClient";

let keys: TestKeys;
beforeAll(async () => {
  keys = await createTestKeys();
});

function client() {
  const core = createFakeCore();
  core.on("POST /oauth/token", (c) => json(c.form?.get("grant_type") === "client_credentials" ? { access_token: `sys-${c.form.get("scope")}`, expires_in: 300 } : { reason: "invalid_grant" }, 200));
  return { core, api: createIpalphaCoreClient(readIpalphaConfig(TEST_ENV), { fetch: core.fetch, jwks: keys.jwks }) };
}

describe("core client", () => {
  test("code exchange → person id (persons token verified locally) + one grant per role with both audiences", async () => {
    const { core, api } = client();
    core.on("POST /oauth/token", async () => json(await tokenAnswer(keys, "p1", ["equipe", "coordenacao"])));
    const answer = await api.exchangeCode({ code: "c", codeVerifier: "v" });
    expect(answer.personId).toBe("p1");
    expect(answer.sessionIdleHours).toBe(12);
    expect(answer.roles.map((r) => r.role)).toEqual(["equipe", "coordenacao"]);
    expect(Object.keys(answer.roles[0].tokens).sort()).toEqual(["ipalpha:persons", "ipalpha:projects"]);
    expect(answer.roles[0].editionId).toBe(TEST_EDITION);
    expect(answer.roles[1].editionId).toBeNull();
  });

  test("a persons token from another key is rejected", async () => {
    const { core, api } = client();
    core.on("POST /oauth/token", async () => json({ tokens_by_resource: { "ipalpha:persons": { access_token: "not-a-jwt" } } }));
    await expect(api.exchangeCode({ code: "c", codeVerifier: "v" })).rejects.toThrow();
  });

  test("relay v2 sends projectId and returns per-role tokens", async () => {
    const { core, api } = client();
    core.on("POST /internal/login/relay/verify", async () => json({ personId: "p2", sessionIdleHours: 24, ...(await tokenAnswer(keys, "p2", ["responsavel"])) }));
    const answer = await api.relayVerify({ challengeId: "ch", code: "123456" });
    expect(answer).toMatchObject({ personId: "p2", sessionIdleHours: 24 });
    expect(answer.roles.map((r) => r.role)).toEqual(["responsavel"]);
    expect(core.callsTo("POST /internal/login/relay/verify")[0].json).toMatchObject({ projectId: "project-test-1", challengeId: "ch" });
    expect(core.callsTo("POST /oauth/token")[0].form?.get("scope")).toBe("login:relay");
  });

  test("a 401 on a per-role call is a revoked token (the session must end); other 4xx stay rejections", async () => {
    const { core, api } = client();
    core.on("GET /persons/p1/data/medical", () => json({ reason: "invalidToken" }, 401));
    await expect(api.readData("role-token", "p1", "medical")).rejects.toBeInstanceOf(IpalphaTokenRevoked);
    core.on("GET /persons/p1/data/medical", () => json({ reason: "notShareable" }, 403));
    await expect(api.readData("role-token", "p1", "medical")).rejects.toBeInstanceOf(IpalphaRejected);
  });

  test("app-client calls retry once with a fresh system token after a bearer 401", async () => {
    const { core, api } = client();
    let n = 0;
    core.on("POST /projects/project-test-1/people/names", () => (++n === 1 ? json({ reason: "invalidToken" }, 401) : json({ items: [{ personId: "p1", name: "Ana" }] })));
    expect(await api.names(["p1"])).toEqual([{ personId: "p1", name: "Ana", nickname: null }]);
    expect(core.callsTo("POST /oauth/token")).toHaveLength(2);
    expect(core.callsTo("POST /oauth/token")[0].form?.get("scope")).toBe("persons:app-names");
  });

  test("names refuses more than 200 ids per call (the caller pages)", async () => {
    const { api } = client();
    await expect(api.names(Array.from({ length: 201 }, (_, i) => `p${i}`))).rejects.toThrow();
  });

  test("memberships: tolerates today's plain array and the contract's {items, nextCursor}", async () => {
    const { core, api } = client();
    core.on("GET /projects/project-test-1/memberships", () => json([{ personId: "p1", role: "equipe", editionId: "e1" }]));
    expect((await api.listMembers({ role: "equipe" })).items[0]).toMatchObject({ personId: "p1", role: "equipe", editionId: "e1" });
    core.on("GET /projects/project-test-1/memberships", () => json({ items: [{ personId: "p2", role: "participante", involved: [{ personId: "p3", purpose: "responsible" }] }], nextCursor: "c2" }));
    const page = await api.listMembers({ role: "participante", involvedPersonId: "p3" });
    expect(page).toMatchObject({ nextCursor: "c2", items: [{ personId: "p2", involved: [{ personId: "p3" }] }] });
    expect(core.callsTo("GET /projects/project-test-1/memberships")[1].query.get("involvedPersonId")).toBe("p3");
  });

  test("send-template posts recipients by person id to notifications-api", async () => {
    const { core, api } = client();
    core.on("POST /projects/project-test-1/messages", () => json({ results: [{ personId: "p1", status: "sent" }, { personId: "p2", status: "noContact" }] }));
    const results = await api.sendTemplate({ templateSlug: "acampa-photos-published", recipients: [{ personId: "p1", variables: {} }, { personId: "p2", variables: {} }], editionId: "e1" });
    expect(results).toEqual([{ personId: "p1", status: "sent" }, { personId: "p2", status: "noContact" }]);
    expect(core.callsTo("POST /oauth/token")[0].form?.get("resource")).toBe("ipalpha:notifications");
  });

  test("core down → IpalphaUnavailable", async () => {
    const { core, api } = client();
    core.setDown(true);
    await expect(api.listEditions()).rejects.toBeInstanceOf(IpalphaUnavailable);
  });
});
