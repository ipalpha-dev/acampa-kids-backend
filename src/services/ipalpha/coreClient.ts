import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IpalphaConfig } from "../../config";

/**
 * Every HTTP call Acampa makes to IPAlpha core lives here (CONTRACTS_ACAMPA
 * §10–§15), behind one interface so tests inject a fake `fetch` and a local
 * JWKS (no network):
 *
 *   auth-api           PAR / authorization_code / SMS relay v2 → per-role tokens
 *   projects-api       per-role tokens (editions, memberships, own roles)
 *   persons-api        per-role tokens (names, count, people list, data/health, registrations)
 *   notifications-api  app client (notifications:send-template: recipients or a role audience)
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

/** persons-api link request (CONTRACTS §25, decision 80) — names come only on the family's own read, never stored */
export interface LinkRequest {
  id: string;
  childId: string;
  proposedResponsibleId: string;
  /** text snapshot of the project name when it was proposed (decision 79) */
  projectName: string;
  status: "pending" | "accepted" | "declined" | "expired" | "cancelled";
  createdAt: string | null;
  expiresAt: string | null;
  child: LinkRequestPerson | null;
  proposedResponsible: LinkRequestPerson | null;
}

export interface LinkRequestPerson {
  name: string;
  nickname: string | null;
  sex: "female" | "male" | null;
}

/** The kinds of data about a person a project role may ask for (projects-api `SHARED_DATA_KINDS`). */
export const SHARED_DATA_KINDS = ["email", "phone", "document", "address", "medical", "school", "emergencyContact"] as const;
export type SharedDataKind = (typeof SHARED_DATA_KINDS)[number];
const SHARED_KIND_SET = new Set<string>(SHARED_DATA_KINDS);
export const isSharedDataKind = (v: unknown): v is SharedDataKind => typeof v === "string" && SHARED_KIND_SET.has(v);

/** One membership asking the signed-in person for kinds about THEMSELVES not granted yet (decision 87). */
export interface PendingKindsItem {
  membershipId: string;
  /** `involved` = they are a responsible listed on a kid's membership; `own` = their own role */
  kind: "involved" | "own";
  /** the kid (involved) or the person themselves (own) */
  personId: string;
  role: string;
  editionId: string | null;
  granted: SharedDataKind[];
  requested: SharedDataKind[];
}

/** projects-api `GET /projects/:id/me/pending-kinds`; `kinds` = everything confirming shares about the person */
export interface PendingKindsView {
  editionId: string | null;
  items: PendingKindsItem[];
  kinds: SharedDataKind[];
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

/** projects-api `GET /projects/:id/memberships/person/:me` (own token): the edition used, the person's own memberships and those naming them as involved (ids only) */
export interface OwnMemberships {
  editionId: string | null;
  memberships: Membership[];
  involved: { personId: string; role: string; editionId: string | null }[];
}

/**
 * notifications-api `audience`: core resolves the members of `roles` (+ edition; only today's birthdays) minus
 * `excludePersonIds` — Acampa never sees them. `birthdayOf`: core finds today's birthdays among those roles and fills
 * `{birthdayNames}` per recipient with the ones that recipient's role sees (none → skipped).
 */
export interface MessageAudience {
  roles: string[];
  editionId?: string;
  birthdayToday?: boolean;
  excludePersonIds?: string[];
  birthdayOf?: { roles: string[] };
}

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

  // ── projects-api (per-role token) ──
  /** the editions Acampa may use (created in Oikos; core answers only those whose apps include Acampa) */
  listEditions(token: string): Promise<Edition[]>;
  /**
   * member lists of one role — leaders / directors, or a role whose `seesPersonsOf` includes it: rows `{personId, role,
   * editionId?, involvedPersonIds}`; `editionId` only `none` or the token's edition (403 editionMismatch / roleNotVisible)
   */
  listMembers(token: string, query: { role?: string; editionId?: string; personId?: string; cursor?: string; limit?: number }): Promise<Page<Membership>>;
  /** the token subject's OWN roles (`personId` must be the token's `sub`): that edition's + project-wide, and the memberships naming them as involved */
  ownMemberships(token: string, personId: string, editionId?: string): Promise<OwnMemberships>;
  addMembership(token: string, input: MembershipInput): Promise<Membership>;
  removeMembership(token: string, input: { personId: string; role: string; editionId?: string }): Promise<void>;

  // ── persons-api (per-role token) ──
  /** names the token's role may see (roles policy `seesPersonsOf`), ≤ 200 ids per call; other ids are silently left out */
  names(token: string, personIds: string[]): Promise<PersonName[]>;
  /** anonymized counts of a project ROLE's members (§23: project + role (+ edition), never person ids); not logged by core */
  count(token: string, input: { role: string; editionId?: string; filters: { healthTags?: HealthTagFilter } }): Promise<CountAnswer>;
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

  // ── persons-api link requests (§25, decision 80) ──
  /**
   * `POST /projects/:projectId/link-requests` with a token whose role has canRegister for the child's role (Acampa: the
   * coordenação). Nothing is linked or shared: a current responsible of the child accepts or declines (30 days).
   * 409 alreadyLinked | requestPending | noCurrentResponsible; 400 notAMinor | missingBirthDate; 403 noGrant | outsideWindow | cannotLinkSelf.
   */
  proposeLinkRequest(token: string, input: { childId: string; responsibleId: string }): Promise<LinkRequest>;
  /** `GET /me/link-requests` with the responsável's token: pending requests for the children they are responsible for */
  myLinkRequests(token: string): Promise<LinkRequest[]>;
  /** `POST /me/link-requests/:id/accept|decline` — any ONE current responsible of the child (decision 83) */
  decideLinkRequest(token: string, id: string, decision: "accept" | "decline"): Promise<LinkRequest>;

  // ── projects-api pending kinds (decision 87, the person's OWN token — Acampa: their `responsavel` role token) ──
  /** `GET /projects/:id/me/pending-kinds?editionId` — 400 unknownEdition, 403 appMismatch, 404 notFound */
  pendingKinds(token: string, editionId?: string): Promise<PendingKindsView>;
  /**
   * `POST /projects/:id/me/pending-kinds/confirm {kinds, editionId?}` — all-or-nothing; `kinds` exactly what was shown
   * (a set). Nothing pending → `confirmed: 0`. 409 `pendingChanged` (body `kinds` = what is pending now) when it differs.
   */
  confirmPendingKinds(token: string, input: { kinds: SharedDataKind[]; editionId?: string }): Promise<PendingKindsView & { confirmed: number }>;

  // ── persons-api imports (§20, the importer's per-role token) ──
  /** `POST /projects/:projectId/imports` multipart: `file` + `data` JSON `{editionId?, targets, appFields}` → `{importId, status}` */
  createImport(token: string, input: { file: Blob; fileName: string; editionId?: string; targets: Record<string, ImportTarget>; appFields: ImportAppField[] }): Promise<{ importId: string; status: string }>;
  /** the job without rows: status, failureReason?, steps, mapping, targets, appFields, reviews, counts */
  getImport(token: string, importId: string): Promise<Record<string, unknown>>;
  /** decisions, in `review` → the job */
  patchImport(token: string, importId: string, decisions: ImportDecisions): Promise<Record<string, unknown>>;
  /**
   * 409 `decisionsPending {pending}`. persons-api writes the memberships itself with its own system scope
   * (decision 75) — no projects token goes along. A refused membership fails its row (`membership:<reason>`);
   * an importer who may no longer register fails the run (`failureReason: membership:<reason>`).
   */
  applyImport(token: string, importId: string): Promise<{ importId: string; status: string }>;
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
  /** the members of an audience (core resolves them; shared variables only) → how many messages core accepted */
  sendTemplateToAudience(input: { templateSlug: string; audience: MessageAudience; variables?: Record<string, string> }): Promise<{ accepted: number }>;
}

const LINK_REQUEST_STATUSES = new Set<LinkRequest["status"]>(["pending", "accepted", "declined", "expired", "cancelled"]);

function toLinkRequestPerson(v: unknown): LinkRequestPerson | null {
  const o = obj(v);
  const name = str(o.name);
  if (!name) return null;
  return { name, nickname: str(o.nickname), sex: o.sex === "female" || o.sex === "male" ? o.sex : null };
}

function toLinkRequest(v: unknown): LinkRequest | null {
  const o = obj(v);
  const id = str(o.id);
  const childId = str(o.childId);
  const proposedResponsibleId = str(o.proposedResponsibleId);
  if (!id || !childId || !proposedResponsibleId) return null;
  const status = LINK_REQUEST_STATUSES.has(o.status as LinkRequest["status"]) ? (o.status as LinkRequest["status"]) : "pending";
  return {
    id,
    childId,
    proposedResponsibleId,
    projectName: str(o.projectName) ?? "",
    status,
    createdAt: str(o.createdAt),
    expiresAt: str(o.expiresAt),
    child: toLinkRequestPerson(o.child),
    proposedResponsible: toLinkRequestPerson(o.proposedResponsible),
  };
}

/** the known kinds of a core list (unknown future kinds are dropped, never shown as a raw key) */
export function toSharedKinds(v: unknown): SharedDataKind[] {
  return Array.isArray(v) ? [...new Set(v.filter(isSharedDataKind))] : [];
}

function toPendingKindsView(v: unknown): PendingKindsView {
  const o = obj(v);
  const items: PendingKindsItem[] = [];
  for (const x of Array.isArray(o.items) ? o.items : []) {
    const i = obj(x);
    const membershipId = str(i.membershipId);
    const personId = str(i.personId);
    const role = str(i.role);
    if (!membershipId || !personId || !role || (i.kind !== "involved" && i.kind !== "own")) continue;
    items.push({ membershipId, kind: i.kind, personId, role, editionId: str(i.editionId), granted: toSharedKinds(i.granted), requested: toSharedKinds(i.requested) });
  }
  return { editionId: str(o.editionId), items, kinds: toSharedKinds(o.kinds).sort() };
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
  // a person-token list answers `involvedPersonIds` (ids only, the responsáveis); the full view `involved`
  const involved = Array.isArray(o.involved)
    ? o.involved
        .map((x) => obj(x))
        .filter((x) => typeof x.personId === "string")
        .map((x) => ({ personId: x.personId as string, purpose: str(x.purpose) ?? "responsible" }))
    : strings(o.involvedPersonIds).map((personId) => ({ personId, purpose: "responsible" }));
  return { id: str(o.id) ?? `${personId}:${role}`, personId, role, editionId: str(o.editionId), involved };
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

    async listEditions(token) {
      const body = await roleCall("editions", token, "GET", `${cfg.projectsApiUrl}/projects/${project()}/editions`);
      return toPage(body, (v) => {
        const o = obj(v);
        const id = str(o.id);
        return id ? { id, name: str(o.name) ?? id, year: typeof o.year === "number" ? o.year : null, status: str(o.status) ?? "active", current: o.current === true } : null;
      }).items;
    },

    async listMembers(token, query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
      if (!params.has("limit")) params.set("limit", "200");
      const body = await roleCall("memberships", token, "GET", `${cfg.projectsApiUrl}/projects/${project()}/memberships?${params.toString()}`);
      return toPage(body, toMembership);
    },

    async ownMemberships(token, personId, editionId) {
      const query = editionId ? `?editionId=${encodeURIComponent(editionId)}` : "";
      const body = obj(await roleCall("memberships/own", token, "GET", `${cfg.projectsApiUrl}/projects/${project()}/memberships/person/${encodeURIComponent(personId)}${query}`));
      const memberships = (Array.isArray(body.memberships) ? body.memberships : []).map(toMembership).filter((m): m is Membership => m !== null && m.personId === personId);
      const involved = (Array.isArray(body.involved) ? body.involved : [])
        .map((x) => obj(x))
        .filter((x) => str(x.personId) && str(x.role) && x.personId !== personId)
        .map((x) => ({ personId: x.personId as string, role: x.role as string, editionId: str(x.editionId) }));
      return { editionId: str(body.editionId), memberships, involved };
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

    async names(token, personIds) {
      if (personIds.length === 0) return [];
      if (personIds.length > NAMES_BATCH_MAX) throw new Error(`names: at most ${NAMES_BATCH_MAX} ids per call`);
      const body = obj(await roleCall("people/names", token, "POST", `${cfg.personsApiUrl}/projects/${project()}/people/names`, { personIds }));
      return (Array.isArray(body.items) ? body.items : [])
        .map((x) => obj(x))
        .filter((x) => typeof x.personId === "string" && typeof x.name === "string")
        .map((x) => ({ personId: x.personId as string, name: x.name as string, nickname: str(x.nickname), sex: toSexCode(x.sex) }));
    },

    async count(token, input) {
      const body = obj(await roleCall("people/count", token, "POST", `${cfg.personsApiUrl}/projects/${project()}/people/count`, input));
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

    async proposeLinkRequest(token, input) {
      const body = await roleCall("link-requests/create", token, "POST", `${cfg.personsApiUrl}/projects/${project()}/link-requests`, input);
      const request = toLinkRequest(body);
      if (!request) throw new IpalphaUnavailable("link-requests/create: no id");
      return request;
    },

    async myLinkRequests(token) {
      const body = await roleCall("link-requests/mine", token, "GET", `${cfg.personsApiUrl}/me/link-requests`);
      return (Array.isArray(body) ? body : []).map(toLinkRequest).filter((r): r is LinkRequest => r !== null);
    },

    async decideLinkRequest(token, id, decision) {
      const body = obj(await roleCall(`link-requests/${decision}`, token, "POST", `${cfg.personsApiUrl}/me/link-requests/${encodeURIComponent(id)}/${decision}`, {}));
      const request = toLinkRequest(body.request);
      if (!request) throw new IpalphaUnavailable(`link-requests/${decision}: no request`);
      return request;
    },

    async pendingKinds(token, editionId) {
      const query = editionId ? `?editionId=${encodeURIComponent(editionId)}` : "";
      return toPendingKindsView(await roleCall("pending-kinds", token, "GET", `${cfg.projectsApiUrl}/projects/${project()}/me/pending-kinds${query}`));
    },

    async confirmPendingKinds(token, { kinds, editionId }) {
      const body = await roleCall("pending-kinds/confirm", token, "POST", `${cfg.projectsApiUrl}/projects/${project()}/me/pending-kinds/confirm`, { kinds, ...(editionId ? { editionId } : {}) });
      const confirmed = obj(body).confirmed;
      return { ...toPendingKindsView(body), confirmed: typeof confirmed === "number" ? confirmed : 0 };
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

    async applyImport(token, importId) {
      const body = obj(await roleCall("imports/apply", token, "POST", `${cfg.personsApiUrl}/imports/${encodeURIComponent(importId)}/apply`, {}));
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

    async sendTemplateToAudience({ templateSlug, audience, variables }) {
      const body = obj(
        await systemCall("messages/audience", NOTIFICATIONS_RESOURCE, SCOPES.sendTemplate, "POST", `${cfg.notificationsApiUrl}/projects/${project()}/messages`, {
          templateSlug,
          audience,
          ...(variables && Object.keys(variables).length ? { variables } : {}),
        }),
      );
      return { accepted: typeof body.accepted === "number" && body.accepted >= 0 ? body.accepted : 0 };
    },
  };
}
