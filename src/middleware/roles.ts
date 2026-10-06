import { createMiddleware } from "hono/factory";
import type { Role, SessionUser } from "../types";

/**
 * Restricts a route to sessions whose ACTIVE audience is one of `allowed`
 * (`admin` = coordenação, `staff` = any team / helper role, `parent` =
 * responsável). Must run after `requireAuth`.
 */
export function requireRole(...allowed: Role[]) {
  return createMiddleware<{ Variables: { activeRole: Role } }>(async (c, next) => {
    const role = c.get("activeRole");
    if (!role || !allowed.includes(role)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Você não tem permissão para acessar este recurso." } }, 403);
    }
    await next();
  });
}

/** The coordenação only: categories, notifications, templates, about. */
export const requireAdmin = requireRole("admin");

/** Deployment owner only (SUPER_ADMIN_PERSON_IDS): seeds, import caches. Must run after `requireAuth`. */
export const requireSuperAdmin = createMiddleware<{ Variables: { user: SessionUser } }>(async (c, next) => {
  if (!c.get("user").superAdmin) {
    return c.json({ error: { code: "FORBIDDEN", message: "Só o administrador da implantação pode fazer isso." } }, 403);
  }
  await next();
});

type ScopeEnv = { Variables: { activeRole: Role; user: SessionUser } };

/** coordenação, or a team session whose resolved scope passes `check` */
function requireScope(check: (scope: import("../services/scope").Scope) => boolean, message: string) {
  return createMiddleware<ScopeEnv>(async (c, next) => {
    const role = c.get("activeRole");
    const forbid = (msg: string) => c.json({ error: { code: "FORBIDDEN", message: msg } }, 403);
    if (role === "admin") return next();
    if (role !== "staff") return forbid("Você não tem permissão para acessar este recurso.");
    // lazy import: scope.ts → models → … keeps this module free of a load-order cycle
    const { resolveScope } = await import("../services/scope");
    if (!check(await resolveScope(c.get("user")))) return forbid(message);
    await next();
  });
}

/** Everything the coordenação does except its own settings: coordenação or `organizacao`. */
export const requireManager = requireScope((s) => s.all, "Só a organização pode fazer isso.");

/** Writes to the programme: coordenação, `organizacao` or `organizacao-jogos`. */
export const requireOrganizer = requireScope((s) => s.all || s.organizer, "Só a organização pode alterar a programação.");
