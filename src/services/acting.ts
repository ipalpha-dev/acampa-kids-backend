import type { Context } from "hono";
import { findCamp, setCampEditionId } from "../models/camps";
import { coreClient } from "./ipalpha";
import { IpalphaTokenRevoked, PERSONS_RESOURCE, PROJECTS_RESOURCE } from "./ipalpha/coreClient";
import { openRoleTokens, revokeSession } from "./session";
import { forgetSessionValidation, rememberValidation, rememberedValidation } from "./sessionValidation";
import { holdsRole } from "./members";
import { currentCampId } from "./campContext";
import { currentViewer } from "./viewer";
import { COORDINATION_ROLE, RESPONSIBLE_ROLE, type CoreRole, type Session } from "../types";
import type { Edition } from "./ipalpha/coreClient";

/**
 * The per-role IPAlpha token a request ACTS with (CONTRACTS §15: "health /
 * contact / details via the acting role token"). Opened from the session on
 * demand and handed to the core client — never kept anywhere else.
 *
 * A missing or expired token throws `IpalphaTokenRevoked`: the error handler
 * (services/coreErrors.ts) ends the session and the client returns to login.
 */
export type Audience = typeof PERSONS_RESOURCE | typeof PROJECTS_RESOURCE;

export function roleToken(session: Session, audience: Audience, role: CoreRole = session.activeRole): string {
  const grant = openRoleTokens(session)[role];
  const token = grant?.tokens[audience];
  if (!grant || !token) throw new IpalphaTokenRevoked(`no ${audience} token for ${role}`);
  if (grant.expiresAt <= Date.now()) throw new IpalphaTokenRevoked(`${role} token expired`);
  return token;
}

/** Same, for the request's own session (set by requireAuth). */
export function actingToken(c: Context, audience: Audience): string {
  const session = c.get("session") as Session | undefined;
  if (!session) throw new IpalphaTokenRevoked("no session");
  return roleToken(session, audience);
}

/** The coordenação token of this session (imports, registrations) — null when the person is not coordenação. */
export function coordinationToken(session: Session, audience: Audience): string | null {
  if (!session.roles.includes(COORDINATION_ROLE)) return null;
  return roleToken(session, audience, COORDINATION_ROLE);
}

/**
 * The family's OWN `responsavel` token of this session (decision 87: they confirm what is shared about
 * themselves) — null when the person is not a responsável here.
 */
export function responsibleToken(session: Session, audience: Audience): string | null {
  if (!session.roles.includes(RESPONSIBLE_ROLE)) return null;
  return roleToken(session, audience, RESPONSIBLE_ROLE);
}

/**
 * The projects token member lists are read with: the session's coordenação token (leaders / directors list),
 * else its acting one (core answers when that role `seesPersonsOf` the listed role, 403 otherwise).
 */
export function membersToken(session: Session): string {
  return coordinationToken(session, PROJECTS_RESOURCE) ?? roleToken(session, PROJECTS_RESOURCE);
}

/**
 * The editions created in Oikos for Acampa, read with the session's acting projects token — Acampa never
 * creates or rolls an edition over (core answers only the editions this app may use).
 */
export async function editionForYear(session: Session, year: number): Promise<Edition | null> {
  return (await coreClient().listEditions(roleToken(session, PROJECTS_RESOURCE))).find((e) => e.year === year) ?? null;
}

/**
 * The projects-api edition of a camp (camps are yearly editions of the one
 * Acampa project). Stored on the camp when it is created / activated (camp-ops
 * metadata, not person data); an older camp without one is looked up by year
 * with the viewer's token (none → null).
 */
export async function campEditionId(campId: string = currentCampId(), session: Session | null = currentViewer()): Promise<string | null> {
  const camp = await findCamp(campId);
  if (!camp) return null;
  if (camp.editionId) return camp.editionId;
  if (!session) return null;
  try {
    const edition = await editionForYear(session, camp.year);
    if (edition) await setCampEditionId(camp._id, edition.id);
    return edition?.id ?? null;
  } catch {
    return null;
  }
}

/** The coordenação tokens + the camp's edition an import / registration needs, or the error to answer. */
export async function coordinationContext(session: Session): Promise<{ ok: true; tokens: { persons: string; projects: string }; editionId: string } | { ok: false; status: 403 | 409; error: { code: string; message: string } }> {
  const persons = coordinationToken(session, PERSONS_RESOURCE);
  const projects = coordinationToken(session, PROJECTS_RESOURCE);
  if (!persons || !projects) return { ok: false, status: 403, error: { code: "COORDINATION_REQUIRED", message: "Só a coordenação cadastra pessoas no IPAlpha." } };
  const editionId = await campEditionId(session.campId, session);
  if (!editionId) return { ok: false, status: 409, error: { code: "EDITION_UNKNOWN", message: "A edição deste acampamento ainda não existe no IPAlpha." } };
  return { ok: true, tokens: { persons, projects }, editionId };
}

/**
 * The coordenação persons token of this session + its expiry, for an import
 * job's background health pass (decision 50) — null when the person is not
 * coordenação or the token is gone / expired. The caller seals it on the job.
 */
export function coordinationJobToken(session: Session): { token: string; expiresAt: number } | null {
  if (!session.roles.includes(COORDINATION_ROLE)) return null;
  const grant = openRoleTokens(session)[COORDINATION_ROLE];
  const token = grant?.tokens[PERSONS_RESOURCE];
  if (!grant || !token || grant.expiresAt <= Date.now()) return null;
  return { token, expiresAt: grant.expiresAt };
}

/**
 * Re-check the acting token and live membership before exposing camp operations.
 * A project-wide role (coordenação) asks pending kinds with NO edition: its token
 * still carries the login edition (auth-api stamps every project token), and
 * projects-api answers 400 unknownEdition once that edition is archived — which
 * would end every history-camp request.
 */
export async function validateSessionRole(session: Session, role: CoreRole = session.activeRole): Promise<void> {
  if (rememberedValidation(session._id, role, session.campId)) return;
  // drop it before the core calls: a check that passes then fails must not leave the old entry
  forgetSessionValidation(session._id);
  try {
    await coreClient().healthLists(roleToken(session, PERSONS_RESOURCE, role));
    const token = roleToken(session, PROJECTS_RESOURCE, role);
    const editionId = role === COORDINATION_ROLE ? undefined : openRoleTokens(session)[role]?.editionId ?? undefined;
    await coreClient().pendingKinds(token, editionId);
    if (!(await holdsRole(session, role, session.campId))) throw new IpalphaTokenRevoked("membership removed");
    rememberValidation(session._id, role, session.campId);
  } catch (err) {
    forgetSessionValidation(session._id);
    if (err instanceof IpalphaTokenRevoked) await revokeSession(session._id);
    throw err;
  }
}
