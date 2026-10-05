import { Hono } from "hono";
import { resolveLocale } from "../i18n";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { findCamp } from "../models/camps";
import { activeCampId, withCamp } from "../services/campContext";
import { clientIp } from "../services/clientIp";
import { authLanguage, coreClient, ipalphaEnabled, mapRelayError, MISCONFIGURED_ERROR, UNAVAILABLE_ERROR } from "../services/ipalpha";
import { IpalphaUnavailable } from "../services/ipalpha/coreClient";
import { accessWindowError, completeLogin, publicUser, sessionCamp, switchableCamps } from "../services/login";
import { holdsRole } from "../services/members";
import { dropSessionRole, openOfflineKey, revokeSession, seal, SessionKeyMissing, switchSessionCamp, switchSessionRole, unseal } from "../services/session";
import { normalizeBrazilPhone } from "../utils";
import ipalphaRoutes from "./ipalpha";

/**
 * /api/auth — sign-in through IPAlpha only (CONTRACTS §10/§15):
 *
 *   /ipalpha/{config,start,complete}  "Entrar com IPAlpha" popup
 *   POST /otp/request {phone}          SMS code sent by auth-api (relay) → {challenge}
 *   POST /otp/verify {challenge, code} identity + per-role tokens → Acampa session
 *   GET  /me, POST /role, POST /camp, POST /logout, GET /offline-key
 *
 * No local OTP, no phone stored: the relay challenge travels back to the
 * browser sealed (AES-GCM) and returns with the code.
 */
const auth = new Hono<{ Variables: AuthVariables }>();

auth.route("/ipalpha", ipalphaRoutes);

const CHALLENGE_INVALID = { code: "OTP_EXPIRED", message: "O código expirou. Peça um novo código." } as const;

function minutesOf(sec: number): number {
  return Math.max(1, Math.round(sec / 60));
}

/** POST /api/auth/otp/request { phone, locale? } — auth-api sends the code (relay). */
auth.post("/otp/request", async (c) => {
  if (!ipalphaEnabled()) return c.json({ error: UNAVAILABLE_ERROR }, 503);
  const body = await c.req.json<{ phone?: string; locale?: string }>().catch(() => null);
  const locale = resolveLocale(body?.locale ?? c.req.header("accept-language"));
  const phone = body?.phone ? normalizeBrazilPhone(body.phone) : null;
  if (!phone) return c.json({ error: { code: "PHONE_INVALID", message: "Informe um celular brasileiro válido com DDD." } }, 400);

  let answer;
  try {
    answer = await coreClient().relayStart({ phone, language: authLanguage(locale), clientIp: clientIp(c) ?? undefined });
  } catch (err) {
    const mapped = mapRelayError("request", err);
    return c.json({ error: mapped.error }, mapped.status);
  }
  let challenge: string;
  try {
    challenge = seal(JSON.stringify({ id: answer.challengeId, exp: Date.now() + answer.expiresInSec * 1000 }));
  } catch (err) {
    if (err instanceof SessionKeyMissing) return c.json({ error: MISCONFIGURED_ERROR }, 500);
    throw err;
  }
  return c.json({
    success: true,
    challenge,
    codeLength: answer.codeLength,
    expiresAt: new Date(Date.now() + answer.expiresInSec * 1000).toISOString(),
    expireMinutes: minutesOf(answer.expiresInSec),
    delivery: "sms",
  });
});

/** POST /api/auth/otp/verify { challenge, code } → the same answer as the popup login. */
auth.post("/otp/verify", async (c) => {
  if (!ipalphaEnabled()) return c.json({ error: UNAVAILABLE_ERROR }, 503);
  const body = await c.req.json<{ challenge?: string; code?: string }>().catch(() => null);
  const code = (body?.code ?? "").replace(/\D/g, "");
  if (code.length < 4 || code.length > 10) return c.json({ error: { code: "OTP_INVALID_FORMAT", message: "Informe os dígitos do código." } }, 400);
  let challengeId: string;
  try {
    const opened = JSON.parse(unseal(body?.challenge ?? "")) as { id?: unknown; exp?: unknown };
    if (typeof opened.id !== "string" || typeof opened.exp !== "number" || opened.exp <= Date.now()) return c.json({ error: CHALLENGE_INVALID }, 400);
    challengeId = opened.id;
  } catch {
    return c.json({ error: CHALLENGE_INVALID }, 400);
  }

  let answer;
  try {
    answer = await coreClient().relayVerify({ challengeId, code });
  } catch (err) {
    const mapped = mapRelayError("verify", err);
    return c.json({ error: mapped.error }, mapped.status);
  }
  const result = await completeLogin(answer);
  return result.ok ? c.json(result.body) : c.json({ error: result.error }, result.status);
});

/** Who am I? (name read live from core) */
auth.get("/me", requireAuth, async (c) => {
  const session = c.get("session");
  const history = session.campId !== activeCampId();
  const camps = await switchableCamps(session);
  return c.json({ user: await publicUser(session, history), camp: await sessionCamp(session.campId), ...(camps ? { camps } : {}) });
});

/**
 * POST /api/auth/role { role } — switch the acting role (no SMS). The role
 * must be in the session's list, its token still valid, its membership still
 * live in projects-api (§15) and its access window open. The offline key
 * rotates (the offline copy is role-scoped and must be wiped).
 */
auth.post("/role", requireAuth, async (c) => {
  const body = await c.req.json<{ role?: unknown }>().catch(() => null);
  const role = typeof body?.role === "string" ? body.role : "";
  const session = c.get("session");
  if (!role || !session.roles.includes(role)) return c.json({ error: { code: "ROLE_FORBIDDEN", message: "Você não tem este perfil." } }, 403);
  let live: boolean;
  try {
    live = await holdsRole(session.personId, role);
  } catch (err) {
    if (err instanceof IpalphaUnavailable) return c.json({ error: UNAVAILABLE_ERROR }, 503);
    throw err;
  }
  if (!live) {
    await dropSessionRole(session, role);
    return c.json({ error: { code: "ROLE_FORBIDDEN", message: "Este perfil não está mais disponível para você." } }, 403);
  }
  const windowErr = await accessWindowError(session.personId, role);
  if (windowErr) return c.json({ error: windowErr }, 403);
  const next = (await switchSessionRole(session._id, role))!;
  const camps = await switchableCamps(next);
  return c.json({ success: true, tokenExpiresAt: next.expiresAt.toISOString(), user: await publicUser(next), camp: await sessionCamp(next.campId), ...(camps ? { camps } : {}) });
});

/**
 * POST /api/auth/camp { campId } — coordenação / super admin jumping to
 * another year (a history session: read-only, coordenação reads).
 */
auth.post("/camp", requireAuth, async (c) => {
  const body = await c.req.json<{ campId?: unknown }>().catch(() => null);
  const campId = typeof body?.campId === "string" ? body.campId : "";
  const session = c.get("session");
  const camps = await switchableCamps(session);
  if (!camps) return c.json({ error: { code: "CAMP_FORBIDDEN", message: "Só a coordenação pode ver outros anos." } }, 403);
  const target = campId ? await findCamp(campId) : null;
  if (!target) return c.json({ error: { code: "CAMP_NOT_FOUND", message: "Acampamento não encontrado." } }, 404);
  const next = (await switchSessionCamp(session._id, target._id))!;
  const history = !target.active;
  return withCamp(target._id, async () =>
    c.json({ success: true, tokenExpiresAt: next.expiresAt.toISOString(), user: await publicUser(next, history), camp: await sessionCamp(next.campId), camps }),
  );
});

/**
 * GET /api/auth/offline-key — the per-session key for the encrypted offline
 * copy (decision 35). Bound to this session; rotated by a new session, a role
 * switch or a camp switch; gone with the session. `campEndsAt` tells the
 * client when to wipe the copy anyway.
 */
auth.get("/offline-key", requireAuth, async (c) => {
  const session = c.get("session");
  c.header("Cache-Control", "no-store");
  const { campPeriod } = await import("../services/camp");
  const period = await campPeriod();
  return c.json({
    key: openOfflineKey(session),
    alg: "AES-GCM",
    role: session.activeRole,
    /** health may be kept offline only by these roles */
    healthAllowed: session.activeRole === "saude" || session.activeRole === "coordenacao",
    sessionExpiresAt: session.expiresAt.toISOString(),
    campEndsAt: period.endsAt ? period.endsAt.toISOString() : null,
  });
});

/** Logout — revokes the session (the client wipes its offline copy). */
auth.post("/logout", requireAuth, async (c) => {
  await revokeSession(c.get("sessionId"));
  return c.json({ success: true });
});

export default auth;
