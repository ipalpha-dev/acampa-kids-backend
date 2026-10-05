/**
 * Test-only support (never shipped: `src/testing` is in .dockerignore). A
 * throwaway MongoDB (mongodb-memory-server), a FAKE IPAlpha core behind a fake
 * `fetch` (auth-api, projects-api, persons-api, notifications-api — the
 * CONTRACTS §10–§13 shapes) and a local ES256 key set standing in for
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
import { ensureSessionIndexes, createSession } from "../services/session";
import { ipalpha } from "../services/ipalpha";
import { createIpalphaCoreClient, type RoleGrant } from "../services/ipalpha/coreClient";
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
  for (const name of ["sessions", "participants", "settings", "userCampState", "ipalphaLoginStates", "camperImports", "schedule_events", "checkinLog", "camperChangeLog", "camperLookups", "occurrences", "medicationDoses", "scores", "sms_usage", "bedrooms"]) {
    await db.collection(name).deleteMany({});
  }
  await db.collection("camps").updateMany({}, { $set: { editionId: null } });
  resetStartRateLimit();
  clearMembersMemo();
}

// ── fake IPAlpha core ─────────────────────────────────────────────────────

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  form: URLSearchParams | null;
  json: unknown;
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
  editions: { id: string; year: number; current: boolean }[];
  templates: Map<string, Record<string, unknown>>;
  messages: { slug: string; recipients: { personId: string; variables: Record<string, string> }[] }[];
  links: { subjectId: string; agentId: string }[];
  /** bearer tokens core refuses with 401 (revoked mid-session) */
  revoked: Set<string>;
  /** person ids persons-api answers as "birthday today" (decision 51) */
  birthdays: Set<string>;
  /** persons whose `medical` the role token may not read (403) */
  medicalForbidden: Set<string>;
  /** E.164 phone → person id (registration answers the existing person for a known phone, like core) */
  phones: Map<string, string>;
  /** person id → birth date (registration finds a responsável's existing kid by name + birth date) */
  births: Map<string, string>;
  nextId: number;
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
    const call: FakeCall = { method, path: url.pathname, query: url.searchParams, headers, form: raw && isForm ? new URLSearchParams(raw) : null, json: raw && !isForm ? JSON.parse(raw) : null };
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

/** A per-role token as auth-api mints it (`projectRole`, `editionId` claims). */
export async function signRoleToken(keys: TestKeys, personId: string, role: string, aud: string, editionId: string | null = TEST_EDITION): Promise<string> {
  return signPersonToken(keys, personId, { aud, projectId: TEST_PROJECT, projectRole: role, ...(editionId && role !== "coordenacao" ? { editionId } : {}) });
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
  core.on("GET /projects/:id/editions", () => json(world.editions.map((e) => ({ id: e.id, projectId: TEST_PROJECT, name: String(e.year), year: e.year, status: "active", version: 1, current: e.current }))));
  core.on("POST /projects/:id/editions/current-by-year", (call) => {
    const year = Number(call.query.get("year"));
    let e = world.editions.find((x) => x.year === year);
    if (!e) world.editions.push((e = { id: `edition-${year}`, year, current: true }));
    for (const x of world.editions) x.current = x === e;
    return json({ id: e.id, name: String(year), year, status: "active", current: true });
  });
  core.on(`GET ${P}/memberships`, (call) => {
    const q = call.query;
    const editionId = q.get("editionId");
    const items = world.memberships
      .filter((m) => !q.get("role") || m.role === q.get("role"))
      .filter((m) => !q.get("personId") || m.personId === q.get("personId"))
      .filter((m) => !editionId || (editionId === "none" ? !m.editionId : m.editionId === editionId))
      .filter((m) => !q.get("involvedPersonId") || (m.involved ?? []).some((i) => i.personId === q.get("involvedPersonId")))
      .map((m, i) => ({ id: `m${i}`, projectId: TEST_PROJECT, personId: m.personId, role: m.role, ...(m.editionId ? { editionId: m.editionId } : {}), kinds: [], joinedBy: "admin", joinedAt: new Date().toISOString(), involved: (m.involved ?? []).map((x) => ({ ...x, kinds: [] })) }));
    return json({ items, nextCursor: null });
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
  core.on(`POST ${P}/people/names`, (call) => {
    const ids = (call.json as { personIds: string[] }).personIds;
    if (ids.length > 200) return json({ reason: "validationFailed" }, 400);
    return json({ items: ids.filter((id) => world.names.has(id)).map((id) => ({ personId: id, name: world.names.get(id), ...(world.sex.has(id) ? { sex: world.sex.get(id) } : {}) })) });
  });
  core.on(`POST ${P}/people/birthdays-today`, (call) => {
    if (!bearer(call).includes("persons:app-names")) return json({ reason: "insufficientScope" }, 403);
    const editionId = (call.json as { editionId?: string } | null)?.editionId;
    const live = new Set(world.memberships.filter((m) => !editionId || !m.editionId || m.editionId === editionId).map((m) => m.personId));
    return json({ personIds: [...world.birthdays].filter((id) => live.has(id)).sort() });
  });
  core.on(`POST ${P}/people/count`, (call) => {
    const body = call.json as { personIds?: string[]; filters: { healthTags?: { allergies?: string[] } } };
    const ids = body.personIds ?? [];
    const byTag: Record<string, number> = {};
    for (const tag of body.filters.healthTags?.allergies ?? []) byTag[tag] = ids.filter((id) => ((world.health.get(id)?.allergies as string[]) ?? []).includes(tag)).length;
    return json({ total: ids.length, byTag });
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
  core.on("GET /health-lists", () => json([{ key: "alergias", options: [{ id: "amendoim", label: { "pt-BR": "Amendoim" }, order: 0, active: true }] }, { key: "alergia-medicamentos", options: [] }, { key: "condicao-cronica", options: [] }]));
  core.on(`GET ${P}/message-templates`, () => json([...world.templates.values()]));
  core.on(`GET ${P}/message-templates/:slug`, (call) => {
    const t = world.templates.get(call.path.split("/").pop()!);
    return t ? json(t) : json({ reason: "notFound" }, 404);
  });
  core.on(`POST ${P}/message-templates`, (call) => {
    const t: Record<string, unknown> = { ...(call.json as Record<string, unknown>), version: 1 };
    world.templates.set(t.slug as string, t);
    return json(t, 201);
  });
  core.on(`PATCH ${P}/message-templates/:slug`, (call) => {
    const slug = call.path.split("/").pop()!;
    const t = { ...world.templates.get(slug), ...(call.json as Record<string, unknown>), version: ((world.templates.get(slug)?.version as number) ?? 0) + 1 };
    world.templates.set(slug, t);
    return json(t);
  });
  core.on(`POST ${P}/messages`, (call) => {
    const body = call.json as { templateSlug: string; recipients: { personId: string; variables: Record<string, string> }[] };
    world.messages.push({ slug: body.templateSlug, recipients: body.recipients });
    return json({ results: body.recipients.map((r) => ({ personId: r.personId, status: "sent" })) });
  });
}

export function emptyWorld(): FakeWorld {
  return { links: [], names: new Map(), sex: new Map(), health: new Map(), memberships: [], editions: [{ id: TEST_EDITION, year: new Date().getFullYear(), current: true }], templates: new Map(), messages: [], revoked: new Set(), birthdays: new Set(), medicalForbidden: new Set(), phones: new Map(), births: new Map(), nextId: 0 };
}

/** Opens an Acampa session for `personId` holding `roles` (tokens signed like auth-api's) and returns the browser token. */
export async function sessionFor(keys: TestKeys, personId: string, roles: string[], activeRole = roles[0]): Promise<string> {
  const grants: RoleGrant[] = await Promise.all(
    roles.map(async (role) => ({
      role,
      tokens: { "ipalpha:persons": await signRoleToken(keys, personId, role, "ipalpha:persons"), "ipalpha:projects": await signRoleToken(keys, personId, role, "ipalpha:projects") },
      expiresAt: Date.now() + 3600_000,
      editionId: role === "coordenacao" ? null : TEST_EDITION,
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
