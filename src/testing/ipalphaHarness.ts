/**
 * Test-only support for the IPAlpha login tests (never shipped: `src/testing`
 * is in .dockerignore). A throwaway MongoDB (mongodb-memory-server), a fake
 * IPAlpha core behind a fake `fetch`, and a local ES256 key set standing in
 * for auth-api's JWKS. Synthetic data only.
 */
import { Hono } from "hono";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { config, readIpalphaConfig, type IpalphaConfig } from "../config";
import { closeDb, getDb, rawDb } from "../db";
import { ensureCampsCollection } from "../models/camps";
import { migrateToCamps } from "../services/campMigration";
import { ensureIndexes } from "../models/users";
import { ensureLoginStateIndexes } from "../models/ipalphaLoginStates";
import { ipalpha } from "../services/ipalpha";
import { createIpalphaCoreClient } from "../services/ipalpha/coreClient";
import authRoutes from "../routes/auth";
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
  await migrateToCamps();
  await ensureIndexes();
  await ensureLoginStateIndexes();
}

export async function stopTestDb(): Promise<void> {
  users--;
  if (users > 0 || !server) return;
  await closeDb();
  await server.stop();
  server = null;
}

/** Empties everything a login test touches (the camp registry stays). */
export async function resetData(): Promise<void> {
  const db = await rawDb();
  for (const name of ["users", "sessions", "staff", "campers", "settings", "userCampState", "ipalphaLoginStates"]) {
    await db.collection(name).deleteMany({});
  }
  resetStartRateLimit();
}

export async function insertStaff(name: string, phone: string): Promise<void> {
  await (await getDb()).collection("staff").insertOne({ name, phone, active: true, createdAt: new Date(), updatedAt: new Date() });
}

export async function insertCamper(name: string, guardianName: string, guardianPhone: string): Promise<void> {
  await (await getDb()).collection("campers").insertOne({ name, guardianName, guardianPhone, createdAt: new Date(), updatedAt: new Date() });
}

export async function userDoc(phone: string): Promise<Record<string, unknown> | null> {
  return (await rawDb()).collection("users").findOne({ phone });
}

// ── fake IPAlpha core ─────────────────────────────────────────────────────

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  form: URLSearchParams | null;
  json: Record<string, unknown> | null;
}

type Handler = (call: FakeCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
    const call: FakeCall = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      form: raw && isForm ? new URLSearchParams(raw) : null,
      json: raw && !isForm ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const handler = handlers.get(`${method} ${url.pathname}`);
    return handler ? handler(call) : json({ reason: "notFound" }, 404);
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

export const TEST_ENV = {
  IPALPHA_AUTH_API_URL: "https://auth.test.invalid",
  IPALPHA_AUTH_ORIGIN: "https://login.test.invalid",
  IPALPHA_PERSONS_API_URL: "https://persons.test.invalid",
  IPALPHA_TOKEN_ISSUER: "https://auth.test.invalid",
  IPALPHA_CLIENT_ID: "acampa-test-client",
  IPALPHA_ENTRY_POINT: "acampa-web",
  IPALPHA_CLIENT_SECRET: "test-client-secret",
  IPALPHA_REDIRECT_URI: "https://acampa.test.invalid/ipalpha/callback",
  IPALPHA_SYSTEM_CLIENT_ID: "acampa-test-system",
  IPALPHA_SYSTEM_CLIENT_SECRET: "test-system-secret",
  IPALPHA_PROJECT_ID: "project-test-1",
  IPALPHA_PROJECTS_API_URL: "https://projects.test.invalid",
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
  const claims: Record<string, unknown> = {
    iss: TEST_ENV.IPALPHA_TOKEN_ISSUER,
    aud: "ipalpha:persons",
    sub: personId,
    token_use: "external_access",
    azp: TEST_ENV.IPALPHA_CLIENT_ID,
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key ?? keys.privateKey);
}

/** IPAlpha on, talking to `core` (fake fetch) and trusting `keys`. */
export function enableIpalpha(core: FakeCore, keys: TestKeys, env: Record<string, string> = TEST_ENV): IpalphaConfig {
  const cfg = readIpalphaConfig(env);
  ipalpha.config = cfg;
  ipalpha.client = createIpalphaCoreClient(cfg, { fetch: core.fetch, jwks: keys.jwks });
  return cfg;
}

export function disableIpalpha(): void {
  ipalpha.config = readIpalphaConfig({});
  ipalpha.client = null;
}

/** The auth routes as the real app mounts them. */
export function testApp() {
  const app = new Hono().route("/api/auth", authRoutes);
  return async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
}
