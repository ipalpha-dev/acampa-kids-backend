/**
 * Test-only support (never shipped: `src/testing` is in .dockerignore). A
 * throwaway MongoDB (mongodb-memory-server), a FAKE IPAlpha core behind a fake
 * `fetch` (auth-api, projects-api, persons-api, notifications-api — the
 * CONTRACTS §10–§13 shapes, with the project ↔ app links contracts: person
 * tokens for editions / members / names / counts, `audience` sends) and a local ES256 key set standing in for
 * auth-api's JWKS. Synthetic data only.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { config, readIpalphaConfig, type IpalphaConfig } from "../config";
import { closeDb, rawDb } from "../db";
import { ensureCampsCollection } from "../models/camps";
import { ensureFirstCamp } from "../services/campMigration";
import { ensureLoginStateIndexes } from "../models/ipalphaLoginStates";
import { ensureParticipantIndexes } from "../models/participants";
import { ensureDispatchDeliveryIndexes } from "../models/dispatchDeliveries";
import { clearImportMemory } from "../services/personImports";
import { clearImportJobs, ensureImportJobIndexes } from "../models/importJobs";
import { ensureImportConflictIndexes } from "../models/importConflicts";
import { ensureUserCampStateIndexes } from "../models/userCampState";
import { ensureSessionIndexes, createSession } from "../services/session";
import { ipalpha } from "../services/ipalpha";
import { createIpalphaCoreClient, type RoleGrant } from "../services/ipalpha/coreClient";
import { clearValidationMemo } from "../services/sessionValidation";
import { clearMembersMemo } from "../services/members";
import { activeCampId } from "../services/campContext";
import { createApp } from "../app";
import { resetStartRateLimit } from "../routes/ipalpha";

let server: MongoMemoryServer | null = null;
let users = 0;

export async function startTestDb(): Promise<void> {
  users++;
  if (server) return;
  server = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? "8.2.6" } });
  config.mongoUri = server.getUri();
  config.dbName = "acampa-ipalpha-test";
  await ensureCampsCollection();
  await ensureFirstCamp();
  await ensureSessionIndexes();
  await ensureParticipantIndexes();
  await ensureLoginStateIndexes();
  await ensureDispatchDeliveryIndexes();
  await ensureImportJobIndexes();
  await ensureImportConflictIndexes();
  await ensureUserCampStateIndexes();
}

export async function stopTestDb(): Promise<void> {
  users--;
  if (users > 0 || !server) return;
  await closeDb();
  await server.stop();
  server = null;
}

/** Empties everything a test touches (the camp registry stays; its edition id is forgotten). */
export async function resetData(): Promise<void> {
  const db = await rawDb();
  for (const name of ["sessions", "participants", "settings", "userCampState", "ipalphaLoginStates", "dispatchDeliveries", "transports", "teams", "schedule_events", "checkinLog", "camperChangeLog", "camperLookups", "occurrences", "medicationDoses", "scores", "sms_usage", "bedrooms", "importConflicts"]) {
    await db.collection(name).deleteMany({});
  }
  await db.collection("camps").updateMany({}, { $set: { editionId: null } });
  resetStartRateLimit();
  clearMembersMemo();
  clearValidationMemo();
  clearImportMemory();
  await clearImportJobs();
}

// ── fake IPAlpha core ─────────────────────────────────────────────────────

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  form: URLSearchParams | null;
  json: unknown;
  /** multipart bodies (persons-api imports) */
  multipart: FormData | null;
}

type Handler = (call: FakeCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface FakeMembership {
  personId: string;
  role: string;
  editionId?: string;
  involved?: { personId: string; purpose: string }[];
}

/** The state the fake core answers from (tests mutate it directly). */
export interface FakeWorld {
  names: Map<string, string>;
  /** persons `sex` ('female' | 'male') — returned with the name (decision 39) */
  sex: Map<string, string>;
  health: Map<string, Record<string, unknown>>;
  memberships: FakeMembership[];
  /** `archived` is unknown to pending-kinds (projects-api 400 unknownEdition); absent = active */
  editions: { id: string; year: number; current: boolean; status?: "active" | "archived" }[];
  /** what notifications-api was asked to send; an audience send records the members core resolved (variables as core rendered them: `name`, `birthdayNames` filled) */
  messages: { slug: string; recipients: { personId: string; variables: Record<string, string> }[]; audience?: FakeAudience }[];
  /** roles policy `seesPersonsOf` (Round 2): role → the roles whose persons it sees (names, member lists, counts); coordenação sees all */
  seesPersonsOf: Record<string, string[]>;
  links: { subjectId: string; agentId: string }[];
  /** persons-api link requests (§25) */
  linkRequests: { id: string; childId: string; proposedResponsibleId: string; requestedBy: string; status: string; decidedBy?: string }[];
  /** bearer tokens core refuses with 401 (revoked mid-session) */
  revoked: Set<string>;
  /** person ids whose birthday is today (notifications-api `audience.birthdayToday`, decision 51) */
  birthdays: Set<string>;
  /** persons whose `medical` the role token may not read (403) */
  medicalForbidden: Set<string>;
  /** E.164 phone → person id (registration answers the existing person for a known phone, like core) */
  phones: Map<string, string>;
  /** person id → birth date (registration finds a responsável's existing kid by name + birth date) */
  births: Map<string, string>;
  /** projects-api pending kinds per CALLER person id (decision 87): what the project asks of them, not granted yet */
  pendingKinds: Map<string, FakePendingItem[]>;
  nextId: number;
}

export interface FakeAudience {
  roles: string[];
  editionId?: string;
  birthdayToday?: boolean;
  excludePersonIds?: string[];
  birthdayOf?: { roles: string[] };
}

export interface FakePendingItem {
  membershipId: string;
  kind: "involved" | "own";
  personId: string;
  role: string;
  editionId?: string;
  granted: string[];
  requested: string[];
}

export function createFakeCore() {
  const calls: FakeCall[] = [];
  const handlers = new Map<string, Handler>();
  let down = false;
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (down) throw new TypeError("fetch failed");
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : null;
    const isForm = headers.get("content-type")?.includes("x-www-form-urlencoded");
    const multipart = init?.body instanceof FormData ? init.body : null;
    const call: FakeCall = { method, path: url.pathname, query: url.searchParams, headers, form: raw && isForm ? new URLSearchParams(raw) : null, json: raw && !isForm ? JSON.parse(raw) : null, multipart };
    calls.push(call);
    const exact = handlers.get(`${method} ${url.pathname}`);
    if (exact) return exact(call);
    for (const [key, handler] of handlers) {
      const [m, pattern] = key.split(" ");
      if (m !== method || !pattern.includes(":")) continue;
      const re = new RegExp(`^${pattern.replace(/:[^/]+/g, "[^/]+")}$`);
      if (re.test(url.pathname)) return handler(call);
    }
    return json({ reason: "notFound" }, 404);
  };
  return {
    calls,
    fetch,
    on(key: string, handler: Handler) {
      handlers.set(key, handler);
    },
    setDown(value: boolean) {
      down = value;
    },
    callsTo(key: string): FakeCall[] {
      return calls.filter((c) => `${c.method} ${c.path}` === key);
    },
  };
}

export type FakeCore = ReturnType<typeof createFakeCore>;

export const TEST_PROJECT = "project-test-1";
export const TEST_EDITION = "edition-2026";

export const TEST_ENV = {
  IPALPHA_AUTH_API_URL: "https://auth.test.invalid",
  IPALPHA_AUTH_ORIGIN: "https://login.test.invalid",
  IPALPHA_PERSONS_API_URL: "https://persons.test.invalid",
  IPALPHA_PROJECTS_API_URL: "https://projects.test.invalid",
  IPALPHA_NOTIFICATIONS_API_URL: "https://notifications.test.invalid",
  IPALPHA_TOKEN_ISSUER: "https://auth.test.invalid",
  IPALPHA_CLIENT_ID: "acampa-test-client",
  IPALPHA_ENTRY_POINT: "acampa-web",
  IPALPHA_CLIENT_SECRET: "test-client-secret",
  IPALPHA_REDIRECT_URI: "https://acampa.test.invalid/ipalpha/callback",
  IPALPHA_SYSTEM_CLIENT_ID: "acampa-test-system",
  IPALPHA_SYSTEM_CLIENT_SECRET: "test-system-secret",
  IPALPHA_PROJECT_ID: TEST_PROJECT,
  SESSION_TOKEN_KEY: "a".repeat(64),
};

export interface TestKeys {
  privateKey: KeyLike;
  otherPrivateKey: KeyLike;
  jwks: ReturnType<typeof createLocalJWKSet>;
}

export async function createTestKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
  return { privateKey, otherPrivateKey: other.privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

export async function signPersonToken(keys: TestKeys, personId: string, overrides: Record<string, unknown> = {}, key?: KeyLike): Promise<string> {
  const claims: Record<string, unknown> = { iss: TEST_ENV.IPALPHA_TOKEN_ISSUER, aud: "ipalpha:persons", sub: personId, token_use: "external_access", azp: TEST_ENV.IPALPHA_CLIENT_ID, ...overrides };
  return new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "test-key" }).setIssuedAt().setExpirationTime("5m").sign(key ?? keys.privateKey);
}

/**
 * A per-role token as auth-api mints it (`projectRole`, `editionId` claims).
 * Coordenação is project-wide, but a real token still carries the login edition
 * (oauth.service.ts stamps every project token) — omitting it hid the archived-edition 400.
 */
export async function signRoleToken(keys: TestKeys, personId: string, role: string, aud: string, editionId: string | null = TEST_EDITION): Promise<string> {
  return signPersonToken(keys, personId, { aud, projectId: TEST_PROJECT, projectRole: role, ...(editionId ? { editionId } : {}) });
}

/** The `/oauth/token` (and relay v2) answer for a person holding `roles`. */
export async function tokenAnswer(keys: TestKeys, personId: string, roles: string[], extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const perAud = async (aud: string) => Promise.all(roles.map(async (role) => ({ projectRole: role, access_token: await signRoleToken(keys, personId, role, aud), expires_in: 3600 })));
  return {
    token_type: "Bearer",
    tokens_by_resource: {
      "ipalpha:persons": { access_token: await signPersonToken(keys, personId), expires_in: 3600 },
      "ipalpha:projects": { access_token: await signPersonToken(keys, personId, { aud: "ipalpha:projects" }), expires_in: 3600 },
    },
    project_role_tokens: { "ipalpha:persons": await perAud("ipalpha:persons"), "ipalpha:projects": await perAud("ipalpha:projects") },
    session_idle_hours: 12,
    ...extra,
  };
}

/** IPAlpha on, talking to `core` (fake fetch) and trusting `keys`. */
export function enableIpalpha(core: FakeCore, keys: TestKeys, env: Record<string, string> = TEST_ENV): IpalphaConfig {
  const cfg = readIpalphaConfig(env);
  ipalpha.config = cfg;
  config.ipalpha = cfg;
  ipalpha.client = createIpalphaCoreClient(cfg, { fetch: core.fetch, jwks: keys.jwks });
  return cfg;
}

export function disableIpalpha(): void {
  ipalpha.config = readIpalphaConfig({});
  config.ipalpha = ipalpha.config;
  ipalpha.client = null;
}

function bearer(call: FakeCall): string {
  return (call.headers.get("authorization") ?? "").replace(/^Bearer /, "");
}

/** the claims of the caller's (test-signed) token — the fake trusts them, like core after verifying */
function claimsOf(call: FakeCall): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(bearer(call).split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Wires the default handlers of every core route Acampa calls, answering from
 * `world`. Individual tests override a route with `core.on(...)`.
 */
export function installFakeCore(core: FakeCore, world: FakeWorld): void {
  const refused = (call: FakeCall) => world.revoked.has(bearer(call));
  const P = `/projects/${TEST_PROJECT}`;
  core.on("POST /oauth/token", (call) => {
    if (call.form?.get("grant_type") === "client_credentials") return json({ access_token: `system:${call.form.get("scope")}`, token_type: "Bearer", expires_in: 300, scope: call.form.get("scope") });
    return json({ reason: "invalid_grant", error: "invalid_grant" }, 400);
  });
  // the app-bound scopes projects:editions|app-members|templates and persons:app-names are gone: person tokens only
  const personCaller = (call: FakeCall) => !bearer(call).startsWith("system:") && typeof claimsOf(call).sub === "string";
  const toView = (m: FakeMembership, i: number) => ({ id: `m${i}`, projectId: TEST_PROJECT, personId: m.personId, role: m.role, ...(m.editionId ? { editionId: m.editionId } : {}), kinds: [], joinedBy: "admin", joinedAt: new Date().toISOString(), involved: (m.involved ?? []).map((x) => ({ ...x, kinds: [] })) });
  core.on("GET /projects/:id/editions", (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    if (!personCaller(call)) return json({ reason: "forbidden" }, 403);
    return json(world.editions.map((e) => ({ id: e.id, name: String(e.year), year: e.year, current: e.current })));
  });
  // Round 2/3: a role lists / counts / names only the roles its `seesPersonsOf` names (coordenação too: by policy, not by rank)
  const roleSees = (own: string, role: string | null) => !!role && (world.seesPersonsOf[own] ?? []).includes(role);
  const sees = (call: FakeCall, role: string | null) => roleSees(String(claimsOf(call).projectRole ?? ""), role);
  /** an explicit edition other than the token's (and not `none`) → 403 editionMismatch */
  const otherEdition = (call: FakeCall, editionId: string | null | undefined) => !!editionId && editionId !== "none" && editionId !== claimsOf(call).editionId;
  /** visible-members: the viewer, whoever names them as involved (a responsável's kids), members of the roles their role sees */
  const visibleTo = (viewer: string, viewerRoles: string[], target: string, editionId?: string | null) =>
    viewer === target ||
    world.memberships.some(
      (m) => m.personId === target && (!m.editionId || !editionId || m.editionId === editionId) && ((m.involved ?? []).some((i) => i.personId === viewer) || viewerRoles.some((r) => roleSees(r, m.role))),
    );
  core.on(`GET ${P}/memberships`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const q = call.query;
    if (!personCaller(call)) return json({ reason: "forbidden" }, 403);
    if (!sees(call, q.get("role"))) return json({ reason: "roleNotVisible" }, 403);
    if (otherEdition(call, q.get("editionId"))) return json({ reason: "editionMismatch" }, 403);
    const editionId = q.get("editionId");
    const items = world.memberships
      .filter((m) => !q.get("role") || m.role === q.get("role"))
      .filter((m) => !q.get("personId") || m.personId === q.get("personId"))
      .filter((m) => !editionId || (editionId === "none" ? !m.editionId : m.editionId === editionId))
      .map((m) => ({ personId: m.personId, role: m.role, ...(m.editionId ? { editionId: m.editionId } : {}), involvedPersonIds: (m.involved ?? []).map((i) => i.personId) }));
    return json({ items, nextCursor: null });
  });
  // decision 13: a person token reads its OWN roles — that edition's (else the current one's) + project-wide
  core.on(`GET ${P}/memberships/person/:personId`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const personId = call.path.split("/").pop()!;
    if (!personCaller(call) || claimsOf(call).sub !== personId) return json({ reason: "forbidden" }, 403);
    const asked = call.query.get("editionId");
    if (asked && !world.editions.some((e) => e.id === asked)) return json({ reason: "unknownEdition" }, 400);
    const editionId = asked ?? world.editions.find((e) => e.current)?.id;
    const inScope = (m: FakeMembership) => !m.editionId || m.editionId === editionId;
    const memberships = world.memberships.filter((m) => m.personId === personId && inScope(m)).map(toView);
    const involved = world.memberships
      .filter((m) => inScope(m) && (m.involved ?? []).some((i) => i.personId === personId))
      .map((m) => ({ personId: m.personId, role: m.role, ...(m.editionId ? { editionId: m.editionId } : {}) }));
    return json({ personId, ...(editionId ? { editionId } : {}), memberships, involved });
  });
  core.on(`POST ${P}/memberships`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const body = call.json as FakeMembership;
    const existing = world.memberships.find((m) => m.personId === body.personId && m.role === body.role && m.editionId === body.editionId);
    if (!existing) world.memberships.push({ personId: body.personId, role: body.role, editionId: body.editionId, involved: body.involved });
    else for (const i of body.involved ?? []) if (!(existing.involved ?? []).some((x) => x.personId === i.personId)) existing.involved = [...(existing.involved ?? []), i];
    return json({ id: "m-new", personId: body.personId, role: body.role, editionId: body.editionId, involved: body.involved ?? [] }, 201);
  });
  core.on(`DELETE ${P}/memberships/:personId/:role`, (call) => {
    const [, , , , personId, role] = call.path.split("/");
    world.memberships = world.memberships.filter((m) => !(m.personId === personId && m.role === role));
    return json({ personId, role });
  });
  core.on("POST /registrations", (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    type Entry = { name: string; birthDate?: string; phone?: string; sex?: string; data?: { medical?: Record<string, unknown> } };
    const body = call.json as { responsible?: Entry & { phone: string }; children?: Entry[]; people?: (Entry & { phone: string })[] };
    const id = () => `person-${++world.nextId}`;
    // like core (persons-api registrations.service): a known phone / the same kid of the same responsável is
    // REUSED (`created: false`) and every data block sent is written over it — `medical` included
    const writeKinds = (personId: string, entry: Entry) => {
      if (entry.data?.medical) world.health.set(personId, entry.data.medical);
    };
    const upsertAdult = (entry: Entry & { phone: string }) => {
      const known = world.phones.get(entry.phone);
      const personId = known ?? id();
      world.names.set(personId, entry.name);
      if (entry.sex) world.sex.set(personId, entry.sex);
      if (!known) world.phones.set(entry.phone, personId);
      writeKinds(personId, entry);
      return { personId, created: !known };
    };
    if (body.people) return json({ people: body.people.map(upsertAdult) }, 201);
    const responsible = upsertAdult(body.responsible!);
    const children = (body.children ?? []).map((c) => {
      const sibling = world.links.filter((l) => l.agentId === responsible.personId).map((l) => l.subjectId).find((kid) => world.births.get(kid) === c.birthDate && world.names.get(kid)?.toLowerCase() === c.name.toLowerCase());
      const personId = sibling ?? id();
      world.names.set(personId, c.name);
      if (c.birthDate) world.births.set(personId, c.birthDate);
      if (c.sex) world.sex.set(personId, c.sex);
      if (!sibling) world.links.push({ subjectId: personId, agentId: responsible.personId });
      writeKinds(personId, c);
      return { personId, created: !sibling, linkId: `link-${world.nextId}` };
    });
    return json({ responsible, children }, 201);
  });
  core.on("POST /links", (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const body = call.json as { subjectId: string; agentId: string };
    if (world.links.some((l) => l.subjectId === body.subjectId && l.agentId === body.agentId)) return json({ reason: "linkExists" }, 409);
    world.links.push(body);
    return json({ id: `link-${world.links.length}`, basis: "minor", status: "active" }, 201);
  });
  // §25 link requests: canRegister (coordenação here) proposes; one current responsible decides
  core.on(`POST ${P}/link-requests`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const claims = claimsOf(call);
    const { childId, responsibleId } = call.json as { childId: string; responsibleId: string };
    if (claims.projectRole !== "coordenacao") return json({ reason: "noGrant" }, 403);
    if (responsibleId === claims.sub || childId === claims.sub) return json({ reason: "cannotLinkSelf" }, 403);
    if (!world.memberships.some((m) => m.personId === childId)) return json({ reason: "notMember" }, 403);
    if (world.links.some((l) => l.subjectId === childId && l.agentId === responsibleId)) return json({ reason: "alreadyLinked" }, 409);
    if (world.linkRequests.some((r) => r.childId === childId && r.proposedResponsibleId === responsibleId && r.status === "pending")) return json({ reason: "requestPending" }, 409);
    if (!world.links.some((l) => l.subjectId === childId)) return json({ reason: "noCurrentResponsible" }, 409);
    const request = { id: `lr-${world.linkRequests.length + 1}`, childId, proposedResponsibleId: responsibleId, requestedBy: String(claims.sub), status: "pending" };
    world.linkRequests.push(request);
    return json({ ...request, projectId: TEST_PROJECT, projectName: "Acampa Kids", expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() }, 201);
  });
  core.on("GET /me/link-requests", (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const sub = String(claimsOf(call).sub);
    const kids = new Set(world.links.filter((l) => l.agentId === sub).map((l) => l.subjectId));
    const person = (id: string) => (world.names.has(id) ? { id, name: world.names.get(id), ...(world.sex.has(id) ? { sex: world.sex.get(id) } : {}) } : undefined);
    return json(
      world.linkRequests
        .filter((r) => r.status === "pending" && kids.has(r.childId))
        .map((r) => ({ ...r, projectId: TEST_PROJECT, projectName: "Acampa Kids", expiresAt: new Date(Date.now() + 86400_000).toISOString(), child: person(r.childId), proposedResponsible: person(r.proposedResponsibleId) })),
    );
  });
  core.on("POST /me/link-requests/:id/:decision", (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const [, , , id, decision] = call.path.split("/");
    const sub = String(claimsOf(call).sub);
    const r = world.linkRequests.find((x) => x.id === id);
    if (!r) return json({ reason: "linkRequestNotFound" }, 404);
    if (r.proposedResponsibleId === sub) return json({ reason: "cannotLinkSelf" }, 403);
    if (!world.links.some((l) => l.subjectId === r.childId && l.agentId === sub)) return json({ reason: "notResponsible" }, 403);
    if (r.status !== "pending") return json({ reason: "requestNotPending", status: r.status }, 409);
    r.status = decision === "accept" ? "accepted" : "declined";
    r.decidedBy = sub;
    if (decision === "accept") world.links.push({ subjectId: r.childId, agentId: r.proposedResponsibleId });
    return json({ request: { ...r, projectId: TEST_PROJECT, projectName: "Acampa Kids", expiresAt: new Date().toISOString() }, ...(decision === "accept" ? { linkId: `link-${world.links.length}` } : {}) });
  });
  // decision 87: the caller's own pending kinds (person token of the project's app)
  const pendingView = (sub: string, editionId?: string | null) => {
    const items = world.pendingKinds.get(sub) ?? [];
    return { ...(editionId ? { editionId } : {}), items, kinds: [...new Set(items.flatMap((i) => i.requested))].sort() };
  };
  core.on(`GET ${P}/me/pending-kinds`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const editionId = call.query.get("editionId");
    // projects-api pending-kinds: an archived edition is unknownEdition (active only)
    if (editionId && !world.editions.some((e) => e.id === editionId && e.status !== "archived")) return json({ reason: "unknownEdition" }, 400);
    return json(pendingView(String(claimsOf(call).sub), editionId));
  });
  core.on(`POST ${P}/me/pending-kinds/confirm`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const sub = String(claimsOf(call).sub);
    const body = call.json as { kinds: string[]; editionId?: string };
    const current = pendingView(sub, body.editionId);
    if (current.items.length === 0) return json({ ...current, confirmed: 0 });
    if (JSON.stringify([...new Set(body.kinds)].sort()) !== JSON.stringify(current.kinds)) return json({ reason: "pendingChanged", kinds: current.kinds }, 409);
    world.pendingKinds.delete(sub);
    return json({ ...current, items: current.items.map((i) => ({ ...i, granted: i.kind === "own" ? [...new Set([...i.granted, ...i.requested])] : i.requested })), confirmed: current.items.length });
  });
  core.on(`POST ${P}/people/names`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    if (!personCaller(call)) return json({ reason: "forbidden" }, 403);
    const { personIds: ids, editionId } = call.json as { personIds: string[]; editionId?: string };
    if (ids.length > 200) return json({ reason: "validationFailed" }, 400);
    if (otherEdition(call, editionId)) return json({ reason: "editionMismatch" }, 403);
    const claims = claimsOf(call);
    const viewer = String(claims.sub);
    const shown = ids.filter((id) => world.names.has(id) && visibleTo(viewer, [String(claims.projectRole ?? "")], id, editionId ?? (claims.editionId as string | undefined)));
    return json({ items: shown.map((id) => ({ personId: id, name: world.names.get(id), ...(world.sex.has(id) ? { sex: world.sex.get(id) } : {}) })) });
  });
  core.on(`POST ${P}/people/count`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    // §23: project + role (+ edition) — never person ids
    const body = call.json as { personIds?: unknown; role: string; editionId?: string; filters: { healthTags?: { allergies?: string[] } } };
    if (!personCaller(call) || !sees(call, body.role)) return json({ reason: "forbidden" }, 403);
    if (otherEdition(call, body.editionId)) return json({ reason: "editionMismatch" }, 403);
    if (body.personIds !== undefined || !body.role) return json({ reason: "validationFailed" }, 400);
    const ids = [...new Set(world.memberships.filter((m) => m.role === body.role && (!body.editionId || m.editionId === body.editionId)).map((m) => m.personId))];
    const byTag: Record<string, number> = {};
    for (const tag of body.filters.healthTags?.allergies ?? []) byTag[tag] = ids.filter((id) => ((world.health.get(id)?.allergies as string[]) ?? []).includes(tag)).length;
    return json({ total: ids.length, byTag });
  });
  core.on(`POST ${P}/people/health-flags`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const ids = (call.json as { personIds: string[] }).personIds;
    if (ids.length > 200) return json({ reason: "validationFailed" }, 400);
    const has = (h: Record<string, unknown> | undefined) => !!h && Object.values(h).some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v === true));
    return json({ items: ids.filter((id) => !world.medicalForbidden.has(id)).map((id) => ({ personId: id, hasHealthInfo: has(world.health.get(id)) })) });
  });
  core.on(`GET ${P}/people`, (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const role = call.query.get("role");
    const ids = [...new Set(world.memberships.filter((m) => m.role === role).map((m) => m.personId))];
    return json({ items: ids.map((id) => ({ personId: id, name: world.names.get(id) ?? "", health: world.health.get(id) ?? null })), nextCursor: null });
  });
  core.on("GET /persons/:id/data/:kind", (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const [, , personId, , kind] = call.path.split("/");
    if (kind !== "medical") return json({ [kind]: null });
    if (world.medicalForbidden.has(personId)) return json({ reason: "noGrant" }, 403);
    const h = world.health.get(personId);
    return h ? json({ health: h }) : json({ reason: "notFound" }, 404);
  });
  core.on("PATCH /persons/:id/data/:kind", (call) => {
    if (refused(call)) return json({ reason: "invalidToken" }, 401);
    const [, , personId] = call.path.split("/");
    if (world.medicalForbidden.has(personId)) return json({ reason: "noGrant" }, 403);
    world.health.set(personId, call.json as Record<string, unknown>);
    return json({ health: call.json });
  });
  core.on("GET /health-lists", (call) => refused(call) ? json({ reason: "invalidToken" }, 401) : json([{ key: "alergias", options: [{ id: "amendoim", label: { "pt-BR": "Amendoim" }, order: 0, active: true }] }, { key: "alergia-medicamentos", options: [] }, { key: "condicao-cronica", options: [] }]));
  // exactly one of `recipients` (→ results) or `audience` + shared `variables` (→ accepted; core resolves the members).
  // Round 2/3: core fills `{name}`, `{aboutName}` (aboutPersonId; a gentle generic when the recipient may not see them)
  // and `{birthdayNames}` — an app sending them, or any empty variable, is refused
  const firstNameOf = (id: string) => (world.names.get(id) ?? "").split(" ")[0];
  const rolesOf = (id: string) => [...new Set(world.memberships.filter((m) => m.personId === id).map((m) => m.role))];
  const aboutFor = (recipient: string, about?: string): Record<string, string> => (!about ? {} : { aboutName: visibleTo(recipient, rolesOf(recipient), about) ? firstNameOf(about) : "sua criança" });
  core.on(`POST ${P}/messages`, (call) => {
    const body = call.json as { templateSlug: string; recipients?: { personId: string; variables: Record<string, string> }[]; audience?: FakeAudience; variables?: Record<string, string>; aboutPersonId?: string };
    if (!bearer(call).includes("notifications:send-template") || (body.recipients === undefined) === (body.audience === undefined)) return json({ reason: "validationFailed" }, 400);
    const sent = [...(body.recipients ?? []).map((r) => r.variables ?? {}), body.variables ?? {}];
    if (sent.some((v) => "name" in v || "aboutName" in v || "birthdayNames" in v)) return json({ reason: "validationFailed", fieldErrors: ["names are filled by core"] }, 400);
    if (sent.some((v) => Object.values(v).some((x) => typeof x !== "string" || !x.trim()))) return json({ reason: "validationFailed", fieldErrors: ["variables must not be empty"] }, 400);
    if (body.recipients) {
      world.messages.push({ slug: body.templateSlug, recipients: body.recipients.map((r) => ({ personId: r.personId, variables: { ...r.variables, name: firstNameOf(r.personId), ...aboutFor(r.personId, body.aboutPersonId) } })) });
      return json({ results: body.recipients.map((r) => ({ personId: r.personId, status: "sent" })) });
    }
    const audience = body.audience!;
    const { roles, editionId, birthdayToday, excludePersonIds = [], birthdayOf } = audience;
    const inEdition = (m: FakeMembership) => !m.editionId || !editionId || m.editionId === editionId;
    const roleOf = new Map<string, string>();
    for (const m of world.memberships) if (roles.includes(m.role) && inEdition(m) && !excludePersonIds.includes(m.personId) && (!birthdayToday || world.birthdays.has(m.personId))) roleOf.set(m.personId, roleOf.get(m.personId) ?? m.role);
    const birthdays = birthdayOf ? [...new Set(world.memberships.filter((m) => birthdayOf.roles.includes(m.role) && inEdition(m) && world.birthdays.has(m.personId)).map((m) => m))] : [];
    const recipients: { personId: string; variables: Record<string, string> }[] = [];
    for (const [personId, role] of [...roleOf].sort(([x], [y]) => x.localeCompare(y))) {
      const seen = birthdays.filter((b) => roleSees(role, b.role)).map((b) => firstNameOf(b.personId));
      if (birthdayOf && seen.length === 0) continue;
      recipients.push({ personId, variables: { ...(body.variables ?? {}), name: firstNameOf(personId), ...aboutFor(personId, body.aboutPersonId), ...(birthdayOf ? { birthdayNames: seen.join(" & ") } : {}) } });
    }
    world.messages.push({ slug: body.templateSlug, recipients, audience });
    return json({ accepted: recipients.length });
  });
}

/** The Acampa roles policy Oikos holds (deployment/fixtures/2/README.md "Who sees whose persons"). */
export function defaultSeesPersonsOf(): Record<string, string[]> {
  const kids = "participante";
  const families = "responsavel";
  const team = "equipe";
  const helpers = ["organizacao", "organizacao-jogos", "pontuacao", "saude", "coletes", "fotografia", "checkin", "checkin-onibus"];
  return {
    coordenacao: [kids, families, team, ...helpers, "coordenacao"],
    equipe: [kids, families, team],
    saude: [kids, families, team],
    organizacao: [kids, families, team],
    "organizacao-jogos": [kids, team],
    pontuacao: [kids],
    fotografia: [kids],
    coletes: [team],
    checkin: [kids, families],
    "checkin-onibus": [kids, families],
    responsavel: [],
    participante: [],
  };
}

export function emptyWorld(): FakeWorld {
  return { links: [], linkRequests: [], names: new Map(), sex: new Map(), health: new Map(), memberships: [], editions: [{ id: TEST_EDITION, year: new Date().getFullYear(), current: true }], seesPersonsOf: defaultSeesPersonsOf(), messages: [], revoked: new Set(), birthdays: new Set(), medicalForbidden: new Set(), phones: new Map(), births: new Map(), pendingKinds: new Map(), nextId: 0 };
}

/** Opens an Acampa session for `personId` holding `roles` (tokens signed like auth-api's) and returns the browser token. */
export async function sessionFor(keys: TestKeys, personId: string, roles: string[], activeRole = roles[0]): Promise<string> {
  const grants: RoleGrant[] = await Promise.all(
    roles.map(async (role) => ({
      role,
      tokens: { "ipalpha:persons": await signRoleToken(keys, personId, role, "ipalpha:persons"), "ipalpha:projects": await signRoleToken(keys, personId, role, "ipalpha:projects") },
      expiresAt: Date.now() + 3600_000,
      editionId: TEST_EDITION,
    })),
  );
  const { token } = await createSession({ personId, grants, activeRole, campId: activeCampId(), hours: 12 });
  return token;
}

/** The whole app as production mounts it: `call(method, path, body?, token?)`. */
export function testApp() {
  const app = createApp();
  return async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };
}
