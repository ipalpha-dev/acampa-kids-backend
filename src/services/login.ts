import { findCamp, listCamps } from "../models/camps";
import { getSettings, staffAccessOpen } from "../models/settings";
import { canSwitchCamps, isSuperAdmin } from "../middleware/auth";
import { activeCamp } from "./campContext";
import { NOT_IN_PROJECT_ERROR } from "./ipalpha";
import type { LoginAnswer, RoleGrant } from "./ipalpha/coreClient";
import { nameOf } from "./people";
import { staffHasAccess } from "./scope";
import { createSession } from "./session";
import { audienceOf, CORE_ROLES, PARTICIPANT_ROLE, RESPONSIBLE_ROLE, type CheckinWindow, type CoreRole, type Session } from "../types";

/**
 * What both login paths (popup and SMS relay) share once core proved who the
 * person is and minted one token per live project role (CONTRACTS §10/§15):
 * the role the session lands on, the access-window gates and the answer.
 */

/** `{ id, label, year, active }` of the session's camp — falls back to the active camp. */
export async function sessionCamp(campId: string): Promise<{ id: string; label: string; year: number; active: boolean }> {
  const camp = (await findCamp(campId)) ?? activeCamp();
  return { id: camp._id, label: camp.label, year: camp.year, active: camp.active };
}

/** Camps the session may switch to (coordenação / super admin), else undefined (field omitted). */
export async function switchableCamps(session: Pick<Session, "personId" | "activeRole">) {
  if (!canSwitchCamps(session)) return undefined;
  return (await listCamps()).map((c) => ({ id: c._id, label: c.label, year: c.year, active: c.active, archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null }));
}

/** Landing order: the most capable role first; unknown future helper keys sit with `equipe`. */
function rank(role: CoreRole): number {
  const i = (CORE_ROLES as readonly string[]).indexOf(role);
  return i === -1 ? CORE_ROLES.indexOf("equipe") : i;
}

/** Roles a person may sign in with (never `participante`), most capable first. */
export function usableRoles(grants: RoleGrant[]): RoleGrant[] {
  return grants.filter((g) => g.role !== PARTICIPANT_ROLE).sort((a, b) => rank(a.role) - rank(b.role));
}

export const NOT_IN_PROJECT = NOT_IN_PROJECT_ERROR;

/**
 * Is the role's access window open right now? Team members (`equipe`) only
 * inside `staffAccessWindow`, responsáveis inside `parentAccessWindow`; every
 * other role (coordenação, helpers) always. Returns the 403 payload, or null.
 */
export async function accessWindowError(personId: string, role: CoreRole) {
  if (isSuperAdmin(personId) && audienceOf(role) === "admin") return null;
  const settings = await getSettings();
  const now = new Date();
  let window: CheckinWindow;
  if (role === RESPONSIBLE_ROLE) {
    if (staffAccessOpen(settings.parentAccessWindow, now)) return null;
    window = settings.parentAccessWindow;
  } else {
    if (staffHasAccess(personId, role, settings, now)) return null;
    window = settings.staffAccessWindow;
  }
  const { from, until } = window;
  const audience = role === RESPONSIBLE_ROLE ? "parent" : "staff";
  if (until && now >= until) {
    return { code: "STAFF_ACCESS_ENDED", message: "O acampamento já terminou. Esperamos você no ano que vem!", audience, opensAt: from?.toISOString() ?? null, closesAt: until.toISOString() };
  }
  return {
    code: "STAFF_ACCESS_NOT_YET",
    audience,
    message: role === RESPONSIBLE_ROLE ? "O app ainda não está liberado para os pais." : "O app ainda não está liberado para a equipe.",
    opensAt: from?.toISOString() ?? null,
    closesAt: until?.toISOString() ?? null,
  };
}

/** The public shape of the session's person (name read live; empty when core cannot answer right now). */
export async function publicUser(session: Pick<Session, "personId" | "roles" | "activeRole">, history = false) {
  let name = "";
  try {
    name = await nameOf(session.personId);
  } catch {
    name = "";
  }
  return {
    id: session.personId,
    personId: session.personId,
    name,
    roles: session.roles,
    /** the acting IPAlpha project role (§10 key) */
    activeRole: session.activeRole,
    /** what the camp-ops screens use: admin (coordenação) | staff | parent */
    audience: history ? "admin" : audienceOf(session.activeRole),
    superAdmin: isSuperAdmin(session.personId),
  };
}

export type LoginResult = { ok: true; body: Record<string, unknown> } | { ok: false; status: 403; error: Record<string, unknown> };

/**
 * Success of any login: picks the landing role (the most capable one whose
 * access window is open), opens the session with every role's tokens and
 * answers `{success, token, tokenExpiresAt, user, camp, camps?}`.
 */
export async function completeLogin(answer: LoginAnswer): Promise<LoginResult> {
  const grants = usableRoles(answer.roles);
  if (grants.length === 0) return { ok: false, status: 403, error: { ...NOT_IN_PROJECT } };
  let landing: RoleGrant | null = null;
  let firstError: Record<string, unknown> | null = null;
  for (const g of grants) {
    const err = await accessWindowError(answer.personId, g.role);
    if (!err) {
      landing = g;
      break;
    }
    firstError ??= err;
  }
  if (!landing) return { ok: false, status: 403, error: firstError ?? { ...NOT_IN_PROJECT } };

  const { token, session } = await createSession({ personId: answer.personId, grants, activeRole: landing.role, hours: answer.sessionIdleHours });
  const camps = await switchableCamps(session);
  console.log(`[auth] session opened (${grants.length} role(s), landing ${landing.role})`);
  return {
    ok: true,
    body: {
      success: true,
      token,
      tokenExpiresAt: session.expiresAt.toISOString(),
      sessionIdleHours: session.hours,
      user: await publicUser(session),
      camp: await sessionCamp(session.campId),
      ...(camps ? { camps } : {}),
    },
  };
}
