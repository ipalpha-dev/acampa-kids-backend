import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IpalphaConfig } from "../../config";

/**
 * Every HTTP call Acampa makes to IPAlpha core (auth-api, persons-api,
 * projects-api) lives here, behind one small interface so tests inject a fake
 * `fetch` and a local JWKS (no network).
 *
 * Rules (see README → IPAlpha): person tokens and person data are used once
 * and dropped — never stored, cached or logged. Only SYSTEM tokens are cached
 * (in memory, until 30 s before they expire). Logs carry reasons, never
 * phones, codes or tokens.
 */

export const PERSONS_RESOURCE = "ipalpha:persons";
const AUTH_RESOURCE = "ipalpha:auth";
const PROJECTS_RESOURCE = "ipalpha:projects";
const RELAY_SCOPE = "login:relay";
const EDITIONS_SCOPE = "projects:editions";
const EXTERNAL_TOKEN_USE = "external_access";
const SYSTEM_TOKEN_SKEW_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;

/** core answered 4xx with a reason (`{reason}` or OAuth `{error}`) */
export class IpalphaRejected extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly body: Record<string, unknown>,
  ) {
    super(`IPAlpha rejected: ${status} ${reason}`);
  }
}

/** core unreachable, timed out, 5xx, or answered something unreadable */
export class IpalphaUnavailable extends Error {}

/** the person token failed local verification (signature, iss, aud, token_use, azp, sub) */
export class IpalphaTokenInvalid extends Error {}

export interface RelayStartAnswer {
  challengeId: string;
  codeLength: number;
  expiresInSec: number;
  sessionIdleHours: number | null;
}

export interface RelayVerifyAnswer {
  personId: string;
  sessionIdleHours: number | null;
}

export interface PhoneEntry {
  e164: string;
  verified: boolean;
}

export interface IpalphaCoreClient {
  /** PAR (RFC 9126) → the popup URL for the SPA */
  startAuthorization(input: { state: string; codeChallenge: string; personHint?: string }): Promise<{ url: string }>;
  /** authorization_code → the `ipalpha:persons` access token (used once, never stored) */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<string>;
  /** local JWKS verification → the person id (`sub`) */
  verifyPersonsToken(token: string): Promise<{ personId: string }>;
  /** `GET /persons/:id/data/phone` with the person's own token, read at use time */
  readPhones(personId: string, personToken: string): Promise<PhoneEntry[]>;
  relayStart(input: { phone: string; language?: string; clientIp?: string }): Promise<RelayStartAnswer>;
  relayVerify(input: { challengeId: string; code: string }): Promise<RelayVerifyAnswer>;
  /** projects-api `current-by-year` for the Acampa project (yearly) */
  markCurrentEdition(year: number): Promise<void>;
}

export interface CoreClientDeps {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** key resolver for person tokens; default: remote JWKS at `{auth}/.well-known/jwks.json` */
  jwks?: JWTVerifyGetKey;
  timeoutMs?: number;
  now?: () => number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function idleHours(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function createIpalphaCoreClient(cfg: IpalphaConfig, deps: CoreClientDeps = {}): IpalphaCoreClient {
  const fetchImpl = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  let jwks = deps.jwks ?? null;
  const systemTokens = new Map<string, { token: string; expiresAt: number }>();

  async function call(label: string, url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new IpalphaUnavailable(`${label}: unreachable`);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status >= 500) throw new IpalphaUnavailable(`${label}: ${res.status}`);
    if (res.status >= 400) {
      const reason = str(body?.reason) ?? str(body?.error) ?? `http${res.status}`;
      throw new IpalphaRejected(res.status, reason, body ?? {});
    }
    if (!body || typeof body !== "object") throw new IpalphaUnavailable(`${label}: unreadable answer`);
    return body;
  }

  const form = (fields: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) params.set(k, v);
    return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params.toString() } satisfies RequestInit;
  };

  async function systemToken(resource: string, scope: string): Promise<string> {
    const key = `${resource} ${scope}`;
    const cached = systemTokens.get(key);
    if (cached && cached.expiresAt - SYSTEM_TOKEN_SKEW_MS > now()) return cached.token;
    const body = await call(
      "client_credentials",
      `${cfg.authApiUrl}/oauth/token`,
      form({ grant_type: "client_credentials", client_id: cfg.systemClientId, client_secret: cfg.systemClientSecret, resource, scope }),
    );
    const token = str(body.access_token);
    if (!token) throw new IpalphaUnavailable("client_credentials: no access_token");
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 60;
    systemTokens.set(key, { token, expiresAt: now() + expiresIn * 1000 });
    return token;
  }

  /** a system call; a 401 drops the cached token and retries once (rotated / revoked token) */
  async function systemCall(label: string, resource: string, scope: string, url: string, payload: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const token = await systemToken(resource, scope);
      try {
        return await call(label, url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
      } catch (err) {
        if (attempt === 0 && err instanceof IpalphaRejected && err.status === 401) {
          systemTokens.delete(`${resource} ${scope}`);
          continue;
        }
        throw err;
      }
    }
  }

  return {
    async startAuthorization({ state, codeChallenge, personHint }) {
      const body = await call(
        "par",
        `${cfg.authApiUrl}/oauth/par`,
        form({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          entry_point: cfg.entryPoint,
          redirect_uri: cfg.redirectUri,
          response_type: "code",
          response_mode: "web_message",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          resource: PERSONS_RESOURCE,
          project_id: cfg.projectId ?? undefined,
          login_hint: personHint,
        }),
      );
      const requestUri = str(body.request_uri);
      if (!requestUri) throw new IpalphaUnavailable("par: no request_uri");
      const query = new URLSearchParams({ client_id: cfg.clientId, entry_point: cfg.entryPoint, request_uri: requestUri });
      return { url: `${cfg.authOrigin}/?${query.toString()}` };
    },

    async exchangeCode({ code, codeVerifier }) {
      const body = await call(
        "token",
        `${cfg.authApiUrl}/oauth/token`,
        form({
          grant_type: "authorization_code",
          code,
          redirect_uri: cfg.redirectUri,
          code_verifier: codeVerifier,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }),
      );
      const byResource = body.tokens_by_resource as Record<string, { access_token?: unknown } | undefined> | undefined;
      const token = str(byResource?.[PERSONS_RESOURCE]?.access_token);
      // no persons token = the person did not grant what Acampa asked for
      if (!token) throw new IpalphaRejected(403, "personsResourceMissing", {});
      return token;
    },

    async verifyPersonsToken(token) {
      jwks ??= createRemoteJWKSet(new URL(`${cfg.authApiUrl}/.well-known/jwks.json`), { timeoutDuration: timeoutMs });
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: cfg.tokenIssuer,
          audience: PERSONS_RESOURCE,
          algorithms: ["ES256"],
          currentDate: new Date(now()),
        }));
      } catch (err) {
        const code = (err as { code?: string }).code ?? "";
        // the key set could not be fetched at all → core is down, not the token's fault
        // (timeout, non-200 / unparsable JWKS = ERR_JOSE_GENERIC, network error = no code)
        if (!code || code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_INVALID" || code === "ERR_JOSE_GENERIC") {
          throw new IpalphaUnavailable(`jwks: ${code || "unreachable"}`);
        }
        throw new IpalphaTokenInvalid(code);
      }
      if (payload.token_use !== EXTERNAL_TOKEN_USE) throw new IpalphaTokenInvalid("token_use");
      if (payload.azp !== cfg.clientId) throw new IpalphaTokenInvalid("azp");
      const personId = str(payload.sub);
      if (!personId) throw new IpalphaTokenInvalid("sub");
      return { personId };
    },

    async readPhones(personId, personToken) {
      const body = await call("persons phone", `${cfg.personsApiUrl}/persons/${encodeURIComponent(personId)}/data/phone`, {
        method: "GET",
        headers: { authorization: `Bearer ${personToken}` },
      });
      const list = Array.isArray(body.phones) ? body.phones : [];
      return list
        .filter((p): p is { e164: string; verified?: unknown } => !!p && typeof (p as { e164?: unknown }).e164 === "string")
        .map((p) => ({ e164: p.e164, verified: p.verified === true }));
    },

    async relayStart({ phone, language, clientIp }) {
      const body = await systemCall("relay/start", AUTH_RESOURCE, RELAY_SCOPE, `${cfg.authApiUrl}/internal/login/relay/start`, {
        clientId: cfg.clientId,
        entryPoint: cfg.entryPoint,
        phone,
        ...(language ? { language } : {}),
        ...(clientIp ? { clientIp } : {}),
      });
      const challengeId = str(body.challengeId);
      if (!challengeId) throw new IpalphaUnavailable("relay/start: no challengeId");
      return {
        challengeId,
        codeLength: typeof body.codeLength === "number" ? body.codeLength : 6,
        expiresInSec: typeof body.expiresInSec === "number" && body.expiresInSec > 0 ? body.expiresInSec : 300,
        sessionIdleHours: idleHours(body.sessionIdleHours),
      };
    },

    async relayVerify({ challengeId, code }) {
      const body = await systemCall("relay/verify", AUTH_RESOURCE, RELAY_SCOPE, `${cfg.authApiUrl}/internal/login/relay/verify`, {
        clientId: cfg.clientId,
        entryPoint: cfg.entryPoint,
        challengeId,
        code,
      });
      const personId = str(body.personId);
      if (!personId) throw new IpalphaUnavailable("relay/verify: no personId");
      return { personId, sessionIdleHours: idleHours(body.sessionIdleHours) };
    },

    async markCurrentEdition(year) {
      if (!cfg.projectId || !cfg.projectsApiUrl) throw new Error("markCurrentEdition: IPALPHA_PROJECT_ID / IPALPHA_PROJECTS_API_URL not set");
      await systemCall(
        "editions/current-by-year",
        PROJECTS_RESOURCE,
        EDITIONS_SCOPE,
        `${cfg.projectsApiUrl}/projects/${encodeURIComponent(cfg.projectId)}/editions/current-by-year?year=${year}`,
        undefined,
      );
    },
  };
}
