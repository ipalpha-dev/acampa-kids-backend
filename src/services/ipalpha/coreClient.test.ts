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
    // coordenação is project-wide, but auth-api still stamps the login edition on its token
    expect(answer.roles[1].editionId).toBe(TEST_EDITION);
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
    core.on("POST /projects/project-test-1/messages", () => (++n === 1 ? json({ reason: "invalidToken" }, 401) : json({ accepted: 3 })));
    expect(await api.sendTemplateToAudience({ templateSlug: "acampa-birthday", audience: { roles: ["participante"], editionId: "e1", birthdayToday: true } })).toEqual({ accepted: 3 });
    expect(core.callsTo("POST /oauth/token")).toHaveLength(2);
    expect(core.callsTo("POST /oauth/token")[0].form?.get("scope")).toBe("notifications:send-template");
  });

  test("names, counts, editions and member lists go with the person's role token (no app-bound scope left)", async () => {
    const { core, api } = client();
    core.on("POST /projects/project-test-1/people/names", () => json({ items: [{ personId: "p1", name: "Ana" }] }));
    core.on("POST /projects/project-test-1/people/count", () => json({ total: 2, byTag: { amendoim: 1 } }));
    core.on("GET /projects/project-test-1/editions", () => json([{ id: "e1", name: "2026", year: 2026, current: true }]));
    expect(await api.names("role-token", ["p1", "p2"])).toEqual([{ personId: "p1", name: "Ana", nickname: null, sex: null }]);
    expect(await api.count("role-token", { role: "participante", filters: {} })).toEqual({ total: 2, byTag: { amendoim: 1 } });
    expect(await api.listEditions("role-token")).toEqual([{ id: "e1", name: "2026", year: 2026, status: "active", current: true }]);
    expect(core.callsTo("POST /oauth/token")).toHaveLength(0);
    for (const call of core.calls) expect(call.headers.get("authorization")).toBe("Bearer role-token");
    core.on("POST /projects/project-test-1/people/names", () => json({ reason: "invalidToken" }, 401));
    await expect(api.names("role-token", ["p1"])).rejects.toBeInstanceOf(IpalphaTokenRevoked);
  });

  test("names refuses more than 200 ids per call (the caller pages)", async () => {
    const { api } = client();
    await expect(api.names("role-token", Array.from({ length: 201 }, (_, i) => `p${i}`))).rejects.toThrow();
  });

  test("own memberships: the self read keeps only the token subject's rows", async () => {
    const { core, api } = client();
    core.on("GET /projects/project-test-1/memberships/person/p1", () => json({ personId: "p1", editionId: "e1", memberships: [{ personId: "p1", role: "equipe", editionId: "e1" }, { personId: "p9", role: "coordenacao" }], involved: [{ personId: "k1", role: "participante", editionId: "e1" }, { personId: "k2", role: "participante" }] }));
    const own = await api.ownMemberships("role-token", "p1", "e1");
    expect(own).toMatchObject({ editionId: "e1", memberships: [{ personId: "p1", role: "equipe", editionId: "e1" }] });
    expect(own.involved).toEqual([{ personId: "k1", role: "participante", editionId: "e1" }, { personId: "k2", role: "participante", editionId: null }]);
    expect(core.callsTo("GET /projects/project-test-1/memberships/person/p1")[0].query.get("editionId")).toBe("e1");
  });

  test("memberships: tolerates today's plain array and the contract's {items, nextCursor}", async () => {
    const { core, api } = client();
    core.on("GET /projects/project-test-1/memberships", () => json([{ personId: "p1", role: "equipe", editionId: "e1" }]));
    expect((await api.listMembers("role-token", { role: "equipe" })).items[0]).toMatchObject({ personId: "p1", role: "equipe", editionId: "e1" });
    core.on("GET /projects/project-test-1/memberships", () => json({ items: [{ personId: "p2", role: "participante", involved: [{ personId: "p3", purpose: "responsible" }] }], nextCursor: "c2" }));
    const page = await api.listMembers("role-token", { role: "participante", editionId: "e1" });
    expect(page).toMatchObject({ nextCursor: "c2", items: [{ personId: "p2", involved: [{ personId: "p3" }] }] });
    expect(core.callsTo("GET /projects/project-test-1/memberships")[1].query.get("editionId")).toBe("e1");
    // a person-token list (Round 2): ids only — `involvedPersonIds` are the responsáveis
    core.on("GET /projects/project-test-1/memberships", () => json({ items: [{ personId: "p2", role: "participante", editionId: "e1", involvedPersonIds: ["p3", "p4"] }], nextCursor: null }));
    expect((await api.listMembers("role-token", { role: "participante" })).items[0].involved).toEqual([{ personId: "p3", purpose: "responsible" }, { personId: "p4", purpose: "responsible" }]);
  });

  test("send-template posts recipients by person id to notifications-api", async () => {
    const { core, api } = client();
    core.on("POST /projects/project-test-1/messages", () => json({ results: [{ personId: "p1", status: "sent" }, { personId: "p2", status: "noContact" }] }));
    const results = await api.sendTemplate({ templateSlug: "acampa-photos-published", recipients: [{ personId: "p1", variables: {} }, { personId: "p2", variables: {} }], editionId: "e1" });
    expect(results).toEqual([{ personId: "p1", status: "sent" }, { personId: "p2", status: "noContact" }]);
    expect(core.callsTo("POST /oauth/token")[0].form?.get("resource")).toBe("ipalpha:notifications");
  });

  test("send-template to an audience: roles + edition + birthdayToday and shared variables → accepted", async () => {
    const { core, api } = client();
    core.on("POST /projects/project-test-1/messages", () => json({ accepted: 4 }));
    expect(await api.sendTemplateToAudience({ templateSlug: "acampa-occurrence", audience: { roles: ["coordenacao"], editionId: "e1" }, variables: { link: "https://x" } })).toEqual({ accepted: 4 });
    expect(core.callsTo("POST /projects/project-test-1/messages")[0].json).toEqual({ templateSlug: "acampa-occurrence", audience: { roles: ["coordenacao"], editionId: "e1" }, variables: { link: "https://x" } });
  });

  test("core down → IpalphaUnavailable", async () => {
    const { core, api } = client();
    core.setDown(true);
    await expect(api.listEditions("role-token")).rejects.toBeInstanceOf(IpalphaUnavailable);
  });
});
