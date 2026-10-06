import type { Context } from "hono";
import { IpalphaRejected, IpalphaTokenRevoked, IpalphaUnavailable } from "./ipalpha/coreClient";
import { revokeSession } from "./session";

/**
 * App-wide error handler for core calls made while serving a request:
 *
 *   IpalphaTokenRevoked  401 from core on the acting role token (revoked /
 *                        expired mid-session — CONTRACTS §10/§15) → the Acampa
 *                        session ends; 401 SESSION_ENDED (the app returns to
 *                        the login screen gracefully)
 *   IpalphaUnavailable   503 IPALPHA_UNAVAILABLE (the "em manutenção" screen)
 *   IpalphaRejected      core said no for this role: 403/404/409/400 with the
 *                        reason (never the token or person data)
 *
 * Anything else is a plain 500 (logged without the request body).
 */
export async function onAppError(err: Error, c: Context): Promise<Response> {
  if (err instanceof IpalphaTokenRevoked) {
    const sessionId = c.get("sessionId") as string | undefined;
    if (sessionId) await revokeSession(sessionId).catch(() => {});
    console.warn(`[ipalpha] role token refused (${err.label}) — session ended`);
    return c.json({ error: { code: "SESSION_ENDED", message: "Sua sessão terminou. Entre de novo." } }, 401);
  }
  if (err instanceof IpalphaUnavailable) {
    console.warn(`[ipalpha] core unavailable (${err.message})`);
    return c.json({ error: { code: "IPALPHA_UNAVAILABLE", message: "Estamos em manutenção. Tente novamente em instantes." } }, 503);
  }
  if (err instanceof IpalphaRejected) {
    const status = err.status === 404 ? 404 : err.status === 409 ? 409 : err.status === 400 ? 400 : 403;
    console.warn(`[ipalpha] core refused (${err.status} ${err.reason})`);
    return c.json({ error: { code: status === 403 ? "CORE_FORBIDDEN" : "CORE_REJECTED", reason: err.reason, message: "O IPAlpha não permitiu esta operação para o seu perfil." } }, status);
  }
  console.error("unhandled error", err);
  return c.json({ error: { code: "INTERNAL", message: "Erro interno." } }, 500);
}
