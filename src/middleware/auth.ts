import { createMiddleware } from "hono/factory";
import { validateSessionRole } from "../services/acting";
import { config, readSuperAdminPersonIds } from "../config";
import { findSessionByToken, revokeSession } from "../services/session";
import { getSettings, staffAccessOpen } from "../models/settings";
import { staffHasAccess } from "../services/scope";
import { activeCampId, withCamp } from "../services/campContext";
import { withViewer } from "../services/viewer";
import { audienceOf, COORDINATION_ROLE, RESPONSIBLE_ROLE, type Role, type Session, type SessionUser } from "../types";

export const superAdminIds = (): string[] => readSuperAdminPersonIds(process.env.SUPER_ADMIN_PERSON_IDS);

/** SUPER_ADMIN_PERSON_IDS member (deployment owner — always coordenação, decision 36). */
export function isSuperAdmin(personId: string): boolean {
  return superAdminIds().includes(personId);
}

/** The bearer token of the request (`Authorization: Bearer …`), or null. */
export function bearerOf(header: string | undefined): string | null {
  const h = header ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** May this session look at other years? Coordenação (project-wide role, every edition) and the super admin. */
export function canSwitchCamps(session: Pick<Session, "personId" | "activeRole">): boolean {
  return session.activeRole === COORDINATION_ROLE || isSuperAdmin(session.personId);
}

/** The request's user (no person data — names are read live where shown). */
export function sessionUser(session: Session, history: boolean): SessionUser {
  const superAdmin = isSuperAdmin(session.personId);
  // a history session reads as the coordenação
  const activeRole: Role = history ? "admin" : audienceOf(session.activeRole);
  return { id: session.personId, personId: session.personId, roles: session.roles, coreRole: session.activeRole, activeRole, superAdmin };
}

/**
 * Plain team members lose their session when `staffAccessWindow` closes;
 * parents when `parentAccessWindow` closes. True when the session was dropped.
 */
export async function accessWindowClosed(session: Session): Promise<boolean> {
  if (session.activeRole === COORDINATION_ROLE || isSuperAdmin(session.personId)) return false;
  const settings = await getSettings();
  const open = session.activeRole === RESPONSIBLE_ROLE ? staffAccessOpen(settings.parentAccessWindow) : staffHasAccess(session.personId, session.activeRole, settings);
  if (open) return false;
  await revokeSession(session._id);
  return true;
}

export type AuthVariables = {
  userId: string;
  sessionId: string;
  session: Session;
  activeRole: Role;
  user: SessionUser;
  campId: string;
};

export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const token = bearerOf(c.req.header("authorization"));
  if (!token) return c.json({ error: { code: "UNAUTHORIZED", message: "Token ausente." } }, 401);
  const session = await findSessionByToken(token);
  if (!session) return c.json({ error: { code: "UNAUTHORIZED", message: "Sessão inválida ou expirada." } }, 401);

  c.set("sessionId", session._id);
  return withCamp(session.campId, () => withViewer(session, async () => {
    await validateSessionRole(session);
    const history = session.campId !== activeCampId();
    if (history) {
      if (!canSwitchCamps(session)) {
        await revokeSession(session._id);
        return c.json({ error: { code: "UNAUTHORIZED", message: "Sessão inválida ou expirada." } }, 401);
      }
    } else if (await accessWindowClosed(session)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "O período de acesso terminou." } }, 401);
    }
    const user = sessionUser(session, history);
    c.set("userId", user.id);
    c.set("sessionId", session._id);
    c.set("session", session);
    c.set("activeRole", user.activeRole);
    c.set("user", user);
    c.set("campId", session.campId);
    await next();
  }));
});

/** config is imported for its side effect on test setups that read it before the routes */
void config;
