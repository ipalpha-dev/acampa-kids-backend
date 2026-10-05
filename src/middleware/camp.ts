import { createMiddleware } from "hono/factory";
import { activeCampId } from "../services/campContext";
import { findSessionByToken } from "../services/session";
import { bearerOf, isSuperAdmin } from "./auth";

/**
 * Refuses every WRITE made from a history session (a session whose camp is not
 * the active one): the year is read-only once archived. Mounted on `/api/*`
 * before the routes. Passes through GET/HEAD/OPTIONS, `/api/auth/*`,
 * unauthenticated requests (the normal 401 path answers those) and the super
 * admin (may fix old data).
 */
export const campWriteGuard = createMiddleware(async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/api/camps")) return next();
  const token = bearerOf(c.req.header("authorization"));
  if (!token) return next();
  const session = await findSessionByToken(token);
  if (!session) return next();
  if (session.campId === activeCampId() || isSuperAdmin(session.personId)) return next();
  return c.json({ error: { code: "CAMP_ARCHIVED", message: "Este ano está arquivado — só leitura." } }, 403);
});
