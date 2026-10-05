import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IpalphaConfig } from "../../config";

/**
 * Every HTTP call Acampa makes to IPAlpha core lives here (CONTRACTS_ACAMPA
 * §10–§15), behind one interface so tests inject a fake `fetch` and a local
 * JWKS (no network):
 *
 *   auth-api           PAR / authorization_code / SMS relay v2 → per-role tokens
 *   projects-api       app client (projects:editions, projects:app-members,
 *                      projects:templates) + per-role tokens (memberships)
 *   persons-api        app client (persons:app-names: names, count, birthdays today) + per-role
 *                      tokens (people list, data/health, registrations)
 *   notifications-api  app client (notifications:send-template)
 *
 * Rules: tokens and person data are never logged. Only SYSTEM (app client)
 * tokens are cached here (memory, until 30 s before expiry); per-role tokens
 * live encrypted in the Acampa session (services/session.ts) and are passed in
 * by the caller. A 401 on a per-role token call throws `IpalphaTokenRevoked`
 * (the session must end — CONTRACTS §10 "apps MUST handle 401").
 */

export const PERSONS_RESOURCE = "ipalpha:persons";
export const PROJECTS_RESOURCE = "ipalpha:projects";
export const AUTH_RESOURCE = "ipalpha:auth";
export const NOTIFICATIONS_RESOURCE = "ipalpha:notifications";
export const DISPATCH_RESOURCE = "ipalpha:dispatch";
/** audiences Acampa asks for at sign-in (§10) */
export const LOGIN_RESOURCES = [PERSONS_RESOURCE, PROJECTS_RESOURCE, AUTH_RESOURCE] as const;

export const SCOPES = {
  relay: "login:relay",
  editions: "projects:editions",
  appMembers: "projects:app-members",
  templates: "projects:templates",
  appNames: "persons:app-names",
  sendTemplate: "notifications:send-template",
  appChannel: "dispatch:app-channel",
} as const;

const EXTERNAL_TOKEN_USE = "external_access";
const SYSTEM_TOKEN_SKEW_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
/** core caps (§11/§12) */
export const NAMES_BATCH_MAX = 200;
export const MESSAGE_RECIPIENTS_MAX = 200;

/** core answered 4xx with a reason (`{reason}` or OAuth `{error}`) */
export class IpalphaRejected extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly body: Record<string, unknown>,
  ) {
    super(`IPAlpha rejected: ${status} ${reason}`);
  }

  /** the RFC 6749 `error` of an OAuth answer (auth-api sends it next to `reason`), else null */
  get oauthError(): string | null {
    return str(this.body.error);
  }
}

/** core unreachable, timed out, 5xx, or answered something unreadable */
export class IpalphaUnavailable extends Error {}

/** the person token failed local verification (signature, iss, aud, token_use, azp, sub) */
export class IpalphaTokenInvalid extends Error {}

/** a per-role token was refused with 401 (expired / revoked mid-session): the Acampa session must end */
export class IpalphaTokenRevoked extends Error {
  constructor(readonly label: string) {
    super(`IPAlpha token revoked (${label})`);
  }
}

/** One live project role of the signed-in person, with its tokens per audience (never logged, never sent to the browser). */
export interface RoleGrant {
  /** project role key (§10: coordenacao, responsavel, equipe, saude, …) */
  role: string;
  /** audience → access token */
  tokens: Record<string, string>;
  /** epoch ms — the earliest expiry among the audiences */
  expiresAt: number;
  /** edition the tokens are bound to (JWT claim, informative), null = project-wide / none */
  editionId: string | null;
}

/** What both login paths (popup code exchange, SMS relay) end with. */
export interface LoginAnswer {
  personId: string;
  /** the entry point's `loginPolicy.sessionIdleHours`, null when absent */
  sessionIdleHours: number | null;
  /** one entry per live project role (empty = the person holds no role → NOT_IN_PROJECT) */
  roles: RoleGrant[];
}

export interface RelayStartAnswer {
  challengeId: string;
  codeLength: number;
  expiresInSec: number;
  sessionIdleHours: number | null;
}

export interface Edition {
  id: string;
  name: string;
  year: number | null;
  status: string;
  current: boolean;
}

export interface Membership {
  id: string;
  personId: string;
  role: string;
  editionId: string | null;
  involved: { personId: string; purpose: string }[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PersonName {
  personId: string;
  name: string;
  nickname: string | null;
  /** decision 39: sex travels with the name ("F" | "M"), null when not informed */
  sex: "F" | "M" | null;
}

/** persons `sex` ('female' | 'male', §12) → Acampa's "F" | "M" */
export function toSexCode(v: unknown): "F" | "M" | null {
  return v === "female" || v === "F" ? "F" : v === "male" || v === "M" ? "M" : null;
}

/** persons-api medical block (`health` storage field, §12 + persons data-validation). */
export interface HealthBlock {
  allergies: string[];
  drugAllergies: string[];
  healthIssues: string[];
  neurodivergent: boolean;
  medications: { name: string; dose: string; times: string[]; asNeeded: boolean; notes: string }[];
  foodRestrictions: string;
  healthNotes: string;
  weightKg: number | null;
  insurance: string;
  insuranceCard: string;
}

/** one row of persons `GET /projects/:projectId/people` (per-role token) */
export interface PersonRow {
  personId: string;
  name: string;
  nickname: string | null;
  sex: "F" | "M" | null;
  /** storage field → block (only the kinds asked for and allowed) */
  data: Record<string, unknown>;
}

export interface HealthTagFilter {
  allergies?: string[];
  drugAllergies?: string[];
  healthIssues?: string[];
  neurodivergent?: boolean;
  medications?: boolean;
  foodRestrictions?: boolean;
}

export interface CountAnswer {
  total: number;
  byTag: Record<string, number>;
}

export interface HealthList {
  key: string;
  options: { id: string; label: Record<string, string> | string; order: number; active: boolean }[];
}

/** Acampa's "F" | "M" → persons `sex` ('female' | 'male'); anything else is not sent (never guessed). */
export function toCoreSex(v: unknown): "female" | "male" | undefined {
  return v === "F" || v === "female" ? "female" : v === "M" || v === "male" ? "male" : undefined;
}

/**
 * One person of persons `POST /registrations` (core `RegistrationPersonDto`): `sex` and `homeChurch` are profile
 * fields written when sent; `data` carries blocks per kind (`document`, `school`, `emergencyContact`, `medical`,
 * `phone`, `email`, `address`) — core writes only the kinds the target role collects.
 */
export interface RegistrationPerson {
  name: string;
  nickname?: string;
  birthDate?: string;
  sex?: "female" | "male";
  homeChurch?: string;
  data?: Record<string, unknown>;
}

/** persons `POST /registrations` (the client adds the project id) */
export interface RegistrationInput {
  role: string;
  responsible?: RegistrationPerson & { phone: string };
  children?: (RegistrationPerson & { birthDate: string })[];
  people?: (RegistrationPerson & { phone: string })[];
}

export interface RegistrationAnswer {
  responsible: { personId: string; created: boolean } | null;
  children: { personId: string; created: boolean; linkId: string | null }[];
  people: { personId: string; created: boolean }[];
}

export interface MembershipInput {
  personId: string;
  role: string;
  editionId?: string;
  onBehalf?: { by: string; via: string };
  involved?: { personId: string; purpose: "responsible"; kinds: string[] }[];
}

/** One app-owned field Acampa hands persons-api on an import (§20 `appFields`). */
export interface ImportAppField {
  key: string;
  description: string;
  kind: "text" | "category";
  categories?: { key: string; label: string }[];
  required: boolean;
}

/** §20 `targets`: row kind → the role its person joins; `responsibleRole` makes it a MINOR row (the responsible joins that role and is linked). */
export interface ImportTarget {
  role: string;
  responsibleRole?: string;
}

/** §20 `PATCH /imports/:id` body: mapping overrides + per-review decisions. */
export interface ImportDecisions {
  mapping?: Record<string, string | null>;
  reviews?: { id: string; choice?: string; value?: string; rows?: Record<string, string> }[];
}

export type ImportRowStatus = "created" | "updated" | "skipped" | "failed";

/** One row of a §20 batch: ids + app field values only (decision 67). */
export interface ImportBatchRow {
  rowRef: string;
  personId: string | null;
  status: ImportRowStatus;
  reason: string | null;
  appFields: Record<string, string>;
  unfilled: string[];
}

export interface ImportBatch {
  batch: number;
  rows: ImportBatchRow[];
}

const ROW_STATUSES: readonly ImportRowStatus[] = ["created", "updated", "skipped", "failed"];

/** A §20/§21 batch (persons `GET /imports/:id/batches` item, or the dispatch `person-import.batch` message). */
export function toImportBatch(v: unknown): ImportBatch | null {
  const o = obj(v);
  const batch = typeof o.batch === "number" && Number.isInteger(o.batch) && o.batch >= 1 ? o.batch : null;
  if (batch === null) return null;
  const rows = (Array.isArray(o.rows) ? o.rows : [])
    .map((r) => obj(r))
    .map((r) => ({
      rowRef: str(r.rowRef) ?? (typeof r.rowRef === "number" ? String(r.rowRef) : ""),
      personId: str(r.personId),
      status: (ROW_STATUSES.includes(r.status as ImportRowStatus) ? r.status : "failed") as ImportRowStatus,
      reason: str(r.reason),
      // values may come as string | number | boolean | null (dispatch AppImportRowDto) — Acampa keeps text; null = empty
      appFields: Object.fromEntries(
        Object.entries(obj(r.appFields))
          .filter(([, val]) => typeof val === "string" || typeof val === "number" || typeof val === "boolean")
          .map(([k, val]) => [k, String(val)]),
      ) as Record<string, string>,
      unfilled: strings(r.unfilled),
    }));
  return { batch, rows };
}

export type LocalizedText = Record<string, string>;

export interface MessageTemplate {
  slug: string;
  name: string;
  channel: "sms" | "email";
  subject?: LocalizedText;
  body: LocalizedText;
  variables: string[];
  version: number;
  updatedAt: string | null;
}

export type TemplateInput = Omit<MessageTemplate, "version" | "updatedAt">;

export interface MessageRecipient {
  personId: string;
  variables: Record<string, string>;
}

export type MessageStatus = "sent" | "notMember" | "noContact" | "failed";

export interface IpalphaCoreClient {
  // ── auth-api ──
  /** PAR (RFC 9126) for the popup: resources persons + projects + auth, project-scoped */
  startAuthorization(input: { state: string; codeChallenge: string; personHint?: string; editionId?: string }): Promise<{ url: string }>;
  /** authorization_code → person id (persons token verified locally) + per-role tokens */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<LoginAnswer>;
  relayStart(input: { phone: string; language?: string; clientIp?: string; editionId?: string }): Promise<RelayStartAnswer>;
  /** relay v2 (§10): identity proof + the same per-role tokens as the code exchange */
  relayVerify(input: { challengeId: string; code: string; editionId?: string }): Promise<LoginAnswer>;

  // ── projects-api (app client) ──
  listEditions(): Promise<Edition[]>;
  /** `current-by-year` (yearly project): find-or-create + mark current */
  markCurrentEdition(year: number): Promise<Edition | null>;
  listMembers(query: { role?: string; editionId?: string; involvedPersonId?: string; personId?: string; cursor?: string; limit?: number }): Promise<Page<Membership>>;
  listTemplates(): Promise<MessageTemplate[]>;
  getTemplate(slug: string): Promise<MessageTemplate | null>;
  createTemplate(input: TemplateInput): Promise<MessageTemplate>;
  updateTemplate(slug: string, patch: Partial<Omit<TemplateInput, "slug" | "channel">>): Promise<MessageTemplate>;
  deleteTemplate(slug: string): Promise<void>;

  // ── projects-api (per-role token) ──
  addMembership(token: string, input: MembershipInput): Promise<Membership>;
  removeMembership(token: string, input: { personId: string; role: string; editionId?: string }): Promise<void>;

  // ── persons-api (app client) ──
  /** names of project members, ≤ 200 ids per call (the caller pages) */
  names(personIds: string[]): Promise<PersonName[]>;
  /**
   * decision 51: ids of the project's live members whose birthday is today (America/Sao_Paulo; 02-29 on 02-28 of
   * non-leap years) — with `editionId` that edition + project-wide. No dates, no names; one anonymized query log in core.
   */
  birthdaysToday(editionId?: string): Promise<string[]>;
  /** anonymized counts of a project ROLE's members (app client — §23: project + role (+ edition), never person ids); not logged by core */
  count(input: { role: string; editionId?: string; filters: { healthTags?: HealthTagFilter } }): Promise<CountAnswer>;

  // ── persons-api (per-role token) ──
  listPeople(token: string, query: { role: string; kinds?: string[]; cursor?: string; limit?: number; q?: string }): Promise<Page<PersonRow>>;
  readData(token: string, personId: string, kind: string): Promise<unknown>;
  writeData(token: string, personId: string, kind: string, block: unknown): Promise<unknown>;
  updateName(token: string, personId: string, input: { name?: string; nickname?: string }): Promise<void>;
  updateBirthDate(token: string, personId: string, birthDate: string): Promise<void>;
  register(token: string, input: RegistrationInput): Promise<RegistrationAnswer>;
  healthLists(token: string): Promise<HealthList[]>;
  /**
   * §23 light flag for the list ♥ (decision 69): does each person have ANY health info? ≤ 200 ids, role token whose
   * role may read `medical` of the targets. Logged by core as a basic-register view, never as a health read.
   */
  healthFlags(token: string, personIds: string[]): Promise<Map<string, boolean>>;

  // ── persons-api imports (§20, the importer's per-role token) ──
  /** `POST /projects/:projectId/imports` multipart: `file` + `data` JSON `{editionId?, targets, appFields}` → `{importId, status}` */
  createImport(token: string, input: { file: Blob; fileName: string; editionId?: string; targets: Record<string, ImportTarget>; appFields: ImportAppField[] }): Promise<{ importId: string; status: string }>;
  /** the job without rows: status, failureReason?, steps, mapping, targets, appFields, reviews, counts */
  getImport(token: string, importId: string): Promise<Record<string, unknown>>;
  /** decisions, in `review` → the job */
  patchImport(token: string, importId: string, decisions: ImportDecisions): Promise<Record<string, unknown>>;
  /** `X-Projects-Authorization` carries the importer's projects token (memberships); 409 `decisionsPending {pending}` */
  applyImport(token: string, projectsToken: string, importId: string): Promise<{ importId: string; status: string }>;
  cancelImport(token: string, importId: string): Promise<void>;
  /**
   * `GET /imports/:id/batches?cursor=<FIRST batch number>&limit≤10` — ids + app field values only (decision 67).
   * `nextCursor` = the next batch number, null when no further batch exists YET (keep `last + 1` to read later ones).
   */
  importBatches(token: string, importId: string, query?: { cursor?: number; limit?: number }): Promise<Page<ImportBatch>>;

  // ── dispatch-api (app client) ──
  /** §21 app-channel handshake token (`dispatch:app-channel`, claim appId); `fresh` drops the cached one first */
  appChannelToken(fresh?: boolean): Promise<{ token: string; expiresAt: number }>;

  // ── notifications-api (app client) ──
  sendTemplate(input: { templateSlug: string; recipients: MessageRecipient[]; editionId?: string }): Promise<{ personId: string; status: MessageStatus }[]>;
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

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * 401 reasons that mean "this bearer is no good" (expired, revoked, rotated
 * key): shared-js `AuthRequired` answers `{reason: "invalidToken"}`;
 * `invalid_token` is RFC 6750's name. A 401 carrying any OTHER reason is the
 * call's own answer (e.g. relay `invalidCode`) — never retried.
 */
const BEARER_REJECTED_REASONS = new Set(["invalidToken", "invalid_token", "tokenRevoked", "unauthorized", "http401"]);

function bearerRejected(err: unknown): boolean {
  if (!(err instanceof IpalphaRejected) || err.status !== 401) return false;
  const reason = str(err.body.reason) ?? str(err.body.error);
  return reason === null || BEARER_REJECTED_REASONS.has(reason);
}

export function toMembership(v: unknown): Membership | null {
  const o = obj(v);
  const personId = str(o.personId);
  const role = str(o.role);
  if (!personId || !role) return null;
  const involved = Array.isArray(o.involved)
    ? o.involved
        .map((x) => obj(x))
        .filter((x) => typeof x.personId === "string")
        .map((x) => ({ personId: x.personId as string, purpose: str(x.purpose) ?? "responsible" }))
    : [];
  return { id: str(o.id) ?? `${personId}:${role}`, personId, role, editionId: str(o.editionId), involved };
}

function toTemplate(v: unknown): MessageTemplate | null {
  const o = obj(v);
  const slug = str(o.slug);
  if (!slug) return null;
  const text = (x: unknown): LocalizedText => Object.fromEntries(Object.entries(obj(x)).filter(([, val]) => typeof val === "string")) as LocalizedText;
  return {
    slug,
    name: str(o.name) ?? slug,
    channel: o.channel === "email" ? "email" : "sms",
    ...(o.subject ? { subject: text(o.subject) } : {}),
    body: text(o.body),
    variables: strings(o.variables),
    version: typeof o.version === "number" ? o.version : 1,
    updatedAt: str(o.updatedAt),
  };
}

/** `{items, nextCursor}` (contract) — tolerates the plain array core answers today */
function toPage<T>(body: unknown, map: (v: unknown) => T | null): Page<T> {
  const list = Array.isArray(body) ? body : Array.isArray(obj(body).items) ? (obj(body).items as unknown[]) : [];
  const items = list.map(map).filter((x): x is T => x !== null);
  return { items, nextCursor: Array.isArray(body) ? null : str(obj(body).nextCursor) };
}

export function createIpalphaCoreClient(cfg: IpalphaConfig, deps: CoreClientDeps = {}): IpalphaCoreClient {
  const fetchImpl = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  let jwks = deps.jwks ?? null;
  const systemTokens = new Map<string, { token: string; expiresAt: number }>();
  const project = () => encodeURIComponent(cfg.projectId);

  async function call(label: string, url: string, init: RequestInit): Promise<unknown> {
    return callWith(label, url, init, timeoutMs);
  }

  async function callWith(label: string, url: string, init: RequestInit, timeout: number): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new IpalphaUnavailable(`${label}: unreachable`);
    }
    if (res.status === 204) return {};
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.status >= 500) throw new IpalphaUnavailable(`${label}: ${res.status}`);
    if (res.status >= 400) {
      const o = obj(body);
      const reason = str(o.reason) ?? str(o.error) ?? `http${res.status}`;
      throw new IpalphaRejected(res.status, reason, o);
    }
    if (body === null || typeof body !== "object") throw new IpalphaUnavailable(`${label}: unreadable answer`);
    return body;
  }

  const form = (fields: Record<string, string | readonly string[] | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (typeof v === "string") params.set(k, v);
      else for (const item of v) params.append(k, item);
    }
    return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params.toString() } satisfies RequestInit;
  };

  const jsonInit = (method: string, token: string, payload?: unknown): RequestInit => ({
    method,
    headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  async function systemToken(resource: string, scope: string): Promise<string> {
    const key = `${resource} ${scope}`;
    const cached = systemTokens.get(key);
    if (cached && cached.expiresAt - SYSTEM_TOKEN_SKEW_MS > now()) return cached.token;
    const body = obj(
      await call(
        "client_credentials",
        `${cfg.authApiUrl}/oauth/token`,
        form({ grant_type: "client_credentials", client_id: cfg.systemClientId, client_secret: cfg.systemClientSecret, resource, scope }),
      ),
    );
    const token = str(body.access_token);
    if (!token) throw new IpalphaUnavailable("client_credentials: no access_token");
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 60;
    systemTokens.set(key, { token, expiresAt: now() + expiresIn * 1000 });
    return token;
  }

  /** an app-client call; a 401 token rejection drops the cached token and retries once (rotated / revoked token) */
  async function systemCall(label: string, resource: string, scope: string, method: string, url: string, payload?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await systemToken(resource, scope);
      try {
        return await call(label, url, jsonInit(method, token, payload));
      } catch (err) {
        if (attempt === 0 && bearerRejected(err)) {
          systemTokens.delete(`${resource} ${scope}`);
          continue;
        }
        throw err;
      }
    }
  }

  /** a per-role token call: a bearer 401 means the person's token was revoked / expired → `IpalphaTokenRevoked` */
  async function roleCall(label: string, token: string, method: string, url: string, payload?: unknown): Promise<unknown> {
    try {
      return await call(label, url, jsonInit(method, token, payload));
    } catch (err) {
      if (bearerRejected(err)) throw new IpalphaTokenRevoked(label);
      throw err;
    }
  }

  async function verifyPersonsToken(token: string): Promise<string> {
    jwks ??= createRemoteJWKSet(new URL(`${cfg.authApiUrl}/.well-known/jwks.json`), { timeoutDuration: timeoutMs });
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: cfg.tokenIssuer, audience: PERSONS_RESOURCE, algorithms: ["ES256"], currentDate: new Date(now()) }));
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      // the key set could not be fetched at all → core is down, not the token's fault
      if (!code || code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_INVALID" || code === "ERR_JOSE_GENERIC") throw new IpalphaUnavailable(`jwks: ${code || "unreachable"}`);
      throw new IpalphaTokenInvalid(code);
    }
    if (payload.token_use !== EXTERNAL_TOKEN_USE) throw new IpalphaTokenInvalid("token_use");
    if (payload.azp !== cfg.clientId) throw new IpalphaTokenInvalid("azp");
    const personId = str(payload.sub);
    if (!personId) throw new IpalphaTokenInvalid("sub");
    return personId;
  }

  /**
   * `/oauth/token` (and relay v2) shape → one grant per role:
   * `project_role_tokens: {<aud>: [{projectRole, access_token, expires_in}]}`.
   */
  function roleGrants(body: Record<string, unknown>): RoleGrant[] {
    const byRole = new Map<string, RoleGrant>();
    for (const [aud, entries] of Object.entries(obj(body.project_role_tokens))) {
      if (!Array.isArray(entries)) continue;
      for (const raw of entries) {
        const e = obj(raw);
        const role = str(e.projectRole) ?? str(e.role);
        const token = str(e.access_token);
        if (!role || !token) continue;
        const expiresAt = now() + (typeof e.expires_in === "number" && e.expires_in > 0 ? e.expires_in : 600) * 1000;
        let editionId: string | null = null;
        try {
          editionId = str(decodeJwt(token).editionId);
        } catch {
          editionId = null;
        }
        const grant = byRole.get(role) ?? { role, tokens: {}, expiresAt, editionId };
        grant.tokens[aud] = token;
        grant.expiresAt = Math.min(grant.expiresAt, expiresAt);
        grant.editionId ??= editionId;
        byRole.set(role, grant);
      }
    }
    return [...byRole.values()];
  }

  return {
    async startAuthorization({ state, codeChallenge, personHint, editionId }) {
      const body = obj(
        await call(
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
            resource: LOGIN_RESOURCES,
            project_id: cfg.projectId,
            edition_id: editionId,
            login_hint: personHint,
          }),
        ),
      );
      const requestUri = str(body.request_uri);
      if (!requestUri) throw new IpalphaUnavailable("par: no request_uri");
      const query = new URLSearchParams({ client_id: cfg.clientId, entry_point: cfg.entryPoint, request_uri: requestUri });
      return { url: `${cfg.authOrigin}/?${query.toString()}` };
    },

    async exchangeCode({ code, codeVerifier }) {
      const body = obj(
        await call(
          "token",
          `${cfg.authApiUrl}/oauth/token`,
          form({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: codeVerifier, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
        ),
      );
      const personsToken = str(obj(obj(body.tokens_by_resource)[PERSONS_RESOURCE]).access_token);
      // no persons token = the person did not grant what Acampa asked for
      if (!personsToken) throw new IpalphaRejected(403, "personsResourceMissing", {});
      const personId = await verifyPersonsToken(personsToken);
      return { personId, sessionIdleHours: idleHours(body.session_idle_hours), roles: roleGrants(body) };
    },

    async relayStart({ phone, language, clientIp, editionId }) {
      const body = obj(
        await systemCall("relay/start", AUTH_RESOURCE, SCOPES.relay, "POST", `${cfg.authApiUrl}/internal/login/relay/start`, {
          clientId: cfg.clientId,
          entryPoint: cfg.entryPoint,
          projectId: cfg.projectId,
          ...(editionId ? { editionId } : {}),
          phone,
          ...(language ? { language } : {}),
          ...(clientIp ? { clientIp } : {}),
        }),
      );
      const challengeId = str(body.challengeId);
      if (!challengeId) throw new IpalphaUnavailable("relay/start: no challengeId");
      return {
        challengeId,
        codeLength: typeof body.codeLength === "number" ? body.codeLength : 6,
        expiresInSec: typeof body.expiresInSec === "number" && body.expiresInSec > 0 ? body.expiresInSec : 300,
        sessionIdleHours: idleHours(body.sessionIdleHours),
      };
    },

    async relayVerify({ challengeId, code, editionId }) {
      const body = obj(
        await systemCall("relay/verify", AUTH_RESOURCE, SCOPES.relay, "POST", `${cfg.authApiUrl}/internal/login/relay/verify`, {
          clientId: cfg.clientId,
          entryPoint: cfg.entryPoint,
          projectId: cfg.projectId,
          ...(editionId ? { editionId } : {}),
          challengeId,
          code,
        }),
      );
      const personId = str(body.personId);
      if (!personId) throw new IpalphaUnavailable("relay/verify: no personId");
      return { personId, sessionIdleHours: idleHours(body.sessionIdleHours ?? body.session_idle_hours), roles: roleGrants(body) };
    },

    async listEditions() {
      const body = await systemCall("editions", PROJECTS_RESOURCE, SCOPES.editions, "GET", `${cfg.projectsApiUrl}/projects/${project()}/editions`);
      return toPage(body, (v) => {
        const o = obj(v);
        const id = str(o.id);
        return id ? { id, name: str(o.name) ?? id, year: typeof o.year === "number" ? o.year : null, status: str(o.status) ?? "active", current: o.current === true } : null;
      }).items;
    },

    async markCurrentEdition(year) {
      const body = obj(await systemCall("editions/current-by-year", PROJECTS_RESOURCE, SCOPES.editions, "POST", `${cfg.projectsApiUrl}/projects/${project()}/editions/current-by-year?year=${year}`));
      const id = str(body.id);
      return id ? { id, name: str(body.name) ?? id, year: typeof body.year === "number" ? body.year : year, status: str(body.status) ?? "active", current: true } : null;
    },

    async listMembers(query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
      const body = await systemCall("app-members", PROJECTS_RESOURCE, SCOPES.appMembers, "GET", `${cfg.projectsApiUrl}/projects/${project()}/memberships?${params.toString()}`);
      return toPage(body, toMembership);
    },

    async listTemplates() {
      const body = await systemCall("templates", PROJECTS_RESOURCE, SCOPES.templates, "GET", `${cfg.projectsApiUrl}/projects/${project()}/message-templates`);
      return toPage(body, toTemplate).items;
    },

    async getTemplate(slug) {
      try {
        return toTemplate(await systemCall("template", PROJECTS_RESOURCE, SCOPES.templates, "GET", `${cfg.projectsApiUrl}/projects/${project()}/message-templates/${encodeURIComponent(slug)}`));
      } catch (err) {
        if (err instanceof IpalphaRejected && err.status === 404) return null;
        throw err;
      }
    },

    async createTemplate(input) {
      const t = toTemplate(await systemCall("template/create", PROJECTS_RESOURCE, SCOPES.templates, "POST", `${cfg.projectsApiUrl}/projects/${project()}/message-templates`, input));
      if (!t) throw new IpalphaUnavailable("template/create: unreadable answer");
      return t;
    },

    async updateTemplate(slug, patch) {
      const t = toTemplate(await systemCall("template/update", PROJECTS_RESOURCE, SCOPES.templates, "PATCH", `${cfg.projectsApiUrl}/projects/${project()}/message-templates/${encodeURIComponent(slug)}`, patch));
      if (!t) throw new IpalphaUnavailable("template/update: unreadable answer");
      return t;
    },

    async deleteTemplate(slug) {
      await systemCall("template/delete", PROJECTS_RESOURCE, SCOPES.templates, "DELETE", `${cfg.projectsApiUrl}/projects/${project()}/message-templates/${encodeURIComponent(slug)}`);
    },

    async addMembership(token, input) {
      const m = toMembership(await roleCall("memberships/add", token, "POST", `${cfg.projectsApiUrl}/projects/${project()}/memberships`, input));
      if (!m) throw new IpalphaUnavailable("memberships/add: unreadable answer");
      return m;
    },

    async removeMembership(token, { personId, role, editionId }) {
      await roleCall(
        "memberships/remove",
        token,
        "DELETE",
        `${cfg.projectsApiUrl}/projects/${project()}/memberships/${encodeURIComponent(personId)}/${encodeURIComponent(role)}?editionId=${encodeURIComponent(editionId ?? "none")}`,
      );
    },

    async names(personIds) {
      if (personIds.length === 0) return [];
      if (personIds.length > NAMES_BATCH_MAX) throw new Error(`names: at most ${NAMES_BATCH_MAX} ids per call`);
      const body = obj(await systemCall("people/names", PERSONS_RESOURCE, SCOPES.appNames, "POST", `${cfg.personsApiUrl}/projects/${project()}/people/names`, { personIds }));
      return (Array.isArray(body.items) ? body.items : [])
        .map((x) => obj(x))
        .filter((x) => typeof x.personId === "string" && typeof x.name === "string")
        .map((x) => ({ personId: x.personId as string, name: x.name as string, nickname: str(x.nickname), sex: toSexCode(x.sex) }));
    },

    async birthdaysToday(editionId) {
      const body = obj(await systemCall("people/birthdays-today", PERSONS_RESOURCE, SCOPES.appNames, "POST", `${cfg.personsApiUrl}/projects/${project()}/people/birthdays-today`, editionId ? { editionId } : {}));
      return Array.isArray(body.personIds) ? body.personIds.filter((x): x is string => typeof x === "string" && x !== "") : [];
    },

    async count(input) {
      const body = obj(await systemCall("people/count", PERSONS_RESOURCE, SCOPES.appNames, "POST", `${cfg.personsApiUrl}/projects/${project()}/people/count`, input));
      const byTag: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj(body.byTag))) if (typeof v === "number") byTag[k] = v;
      return { total: typeof body.total === "number" ? body.total : 0, byTag };
    },

    async listPeople(token, { role, kinds, cursor, limit, q }) {
      const params = new URLSearchParams({ role });
      if (kinds?.length) params.set("kinds", kinds.join(","));
      if (cursor) params.set("cursor", cursor);
      if (limit) params.set("limit", String(limit));
      if (q) params.set("q", q);
      const body = await roleCall("people", token, "GET", `${cfg.personsApiUrl}/projects/${project()}/people?${params.toString()}`);
      return toPage(body, (v) => {
        const o = obj(v);
        const personId = str(o.personId);
        if (!personId) return null;
        const { personId: _p, name, nickname, sex, ...data } = o;
        return { personId, name: typeof name === "string" ? name : "", nickname: str(nickname), sex: toSexCode(sex), data };
      });
    },

    async readData(token, personId, kind) {
      const body = obj(await roleCall(`data/${kind}`, token, "GET", `${cfg.personsApiUrl}/persons/${encodeURIComponent(personId)}/data/${encodeURIComponent(kind)}?projectId=${project()}`));
      // the answer is wrapped by storage field: {"health": block}
      const values = Object.values(body);
      return values.length === 1 ? values[0] : body;
    },

    async writeData(token, personId, kind, block) {
      const body = obj(await roleCall(`data/${kind}/write`, token, "PATCH", `${cfg.personsApiUrl}/persons/${encodeURIComponent(personId)}/data/${encodeURIComponent(kind)}?projectId=${project()}`, block));
      const values = Object.values(body);
      return values.length === 1 ? values[0] : body;
    },

    async updateName(token, personId, input) {
      await roleCall("persons/name", token, "PATCH", `${cfg.personsApiUrl}/persons/${encodeURIComponent(personId)}/name?projectId=${project()}`, input);
    },

    async updateBirthDate(token, personId, birthDate) {
      await roleCall("persons/birth-date", token, "PATCH", `${cfg.personsApiUrl}/persons/${encodeURIComponent(personId)}/birth-date?projectId=${project()}`, { birthDate });
    },

    async register(token, input) {
      const body = obj(await roleCall("registrations", token, "POST", `${cfg.personsApiUrl}/registrations`, { projectId: cfg.projectId, ...input }));
      const responsible = obj(body.responsible);
      return {
        responsible: str(responsible.personId) ? { personId: responsible.personId as string, created: responsible.created === true } : null,
        children: (Array.isArray(body.children) ? body.children : [])
          .map((x) => obj(x))
          .filter((x) => typeof x.personId === "string")
          .map((x) => ({ personId: x.personId as string, created: x.created === true, linkId: str(x.linkId) })),
        people: (Array.isArray(body.people) ? body.people : [])
          .map((x) => obj(x))
          .filter((x) => typeof x.personId === "string")
          .map((x) => ({ personId: x.personId as string, created: x.created === true })),
      };
    },

    async healthLists(token) {
      const body = await roleCall("health-lists", token, "GET", `${cfg.personsApiUrl}/health-lists`);
      return (Array.isArray(body) ? body : [])
        .map((x) => obj(x))
        .filter((x) => typeof x.key === "string")
        .map((x) => ({
          key: x.key as string,
          options: (Array.isArray(x.options) ? x.options : [])
            .map((o) => obj(o))
            .filter((o) => typeof o.id === "string")
            .map((o) => ({ id: o.id as string, label: (typeof o.label === "string" ? o.label : obj(o.label)) as HealthList["options"][number]["label"], order: typeof o.order === "number" ? o.order : 0, active: o.active !== false })),
        }));
    },

    async healthFlags(token, personIds) {
      const out = new Map<string, boolean>();
      if (personIds.length === 0) return out;
      if (personIds.length > NAMES_BATCH_MAX) throw new Error(`healthFlags: at most ${NAMES_BATCH_MAX} ids per call`);
      const body = obj(await roleCall("people/health-flags", token, "POST", `${cfg.personsApiUrl}/projects/${project()}/people/health-flags`, { personIds }));
      for (const x of Array.isArray(body.items) ? body.items : []) {
        const o = obj(x);
        if (typeof o.personId === "string") out.set(o.personId, o.hasHealthInfo === true);
      }
      return out;
    },

    async createImport(token, { file, fileName, editionId, targets, appFields }) {
      const form = new FormData();
      form.set("file", file, fileName);
      form.set("data", JSON.stringify({ ...(editionId ? { editionId } : {}), targets, appFields }));
      let body: Record<string, unknown>;
      try {
        // multipart: no content-type header (fetch sets the boundary); uploads get a longer timeout
        body = obj(await callWith("imports/create", `${cfg.personsApiUrl}/projects/${project()}/imports`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }, Math.max(timeoutMs, 30_000)));
      } catch (err) {
        if (bearerRejected(err)) throw new IpalphaTokenRevoked("imports/create");
        throw err;
      }
      const importId = str(body.importId);
      if (!importId) throw new IpalphaUnavailable("imports/create: no importId");
      return { importId, status: str(body.status) ?? "analysing" };
    },

    async getImport(token, importId) {
      return obj(await roleCall("imports/get", token, "GET", `${cfg.personsApiUrl}/imports/${encodeURIComponent(importId)}`));
    },

    async patchImport(token, importId, decisions) {
      return obj(await roleCall("imports/patch", token, "PATCH", `${cfg.personsApiUrl}/imports/${encodeURIComponent(importId)}`, decisions));
    },

    async applyImport(token, projectsToken, importId) {
      const init = jsonInit("POST", token, {});
      init.headers = { ...(init.headers as Record<string, string>), "x-projects-authorization": `Bearer ${projectsToken}` };
      let body: Record<string, unknown>;
      try {
        body = obj(await call("imports/apply", `${cfg.personsApiUrl}/imports/${encodeURIComponent(importId)}/apply`, init));
      } catch (err) {
        if (bearerRejected(err)) throw new IpalphaTokenRevoked("imports/apply");
        throw err;
      }
      return { importId: str(body.importId) ?? importId, status: str(body.status) ?? "applying" };
    },

    async cancelImport(token, importId) {
      await roleCall("imports/cancel", token, "DELETE", `${cfg.personsApiUrl}/imports/${encodeURIComponent(importId)}`);
    },

    async importBatches(token, importId, query = {}) {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set("cursor", String(Math.max(1, Math.floor(query.cursor))));
      params.set("limit", String(Math.max(1, Math.min(10, query.limit ?? 10))));
      const body = await roleCall("imports/batches", token, "GET", `${cfg.personsApiUrl}/imports/${encodeURIComponent(importId)}/batches?${params.toString()}`);
      return toPage(body, toImportBatch);
    },

    async appChannelToken(fresh = false) {
      const key = `${DISPATCH_RESOURCE} ${SCOPES.appChannel}`;
      if (fresh) systemTokens.delete(key);
      const token = await systemToken(DISPATCH_RESOURCE, SCOPES.appChannel);
      return { token, expiresAt: systemTokens.get(key)?.expiresAt ?? now() + 60_000 };
    },

    async sendTemplate({ templateSlug, recipients, editionId }) {
      if (recipients.length === 0) return [];
      if (recipients.length > MESSAGE_RECIPIENTS_MAX) throw new Error(`sendTemplate: at most ${MESSAGE_RECIPIENTS_MAX} recipients per call`);
      const body = obj(
        await systemCall("messages", NOTIFICATIONS_RESOURCE, SCOPES.sendTemplate, "POST", `${cfg.notificationsApiUrl}/projects/${project()}/messages`, {
          templateSlug,
          recipients,
          ...(editionId ? { editionId } : {}),
        }),
      );
      return (Array.isArray(body.results) ? body.results : [])
        .map((x) => obj(x))
        .filter((x) => typeof x.personId === "string")
        .map((x) => ({ personId: x.personId as string, status: (["sent", "notMember", "noContact", "failed"].includes(x.status as string) ? x.status : "failed") as MessageStatus }));
    },
  };
}
