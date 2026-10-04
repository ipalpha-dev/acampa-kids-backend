import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { resolveLocale } from "../i18n";
import { findByPersonId } from "../models/users";
import { consumeLoginState, saveLoginState } from "../models/ipalphaLoginStates";
import { coreClient, ipalpha, ipalphaEnabled, IpalphaRejected, IpalphaTokenInvalid, IpalphaUnavailable, MISCONFIGURED_ERROR, UNAVAILABLE_ERROR } from "../services/ipalpha";
import { clientIp } from "../services/clientIp";
import type { PhoneEntry } from "../services/ipalpha/coreClient";
import { NO_PROFILE_ERROR, bindPersonId, completeLogin, frozenError, landingRole, resolveAccountByPhone, staffWindowError } from "../services/login";
import type { User } from "../types";
import { normalizeBrazilPhone } from "../utils";

/**
 * "Entrar com IPAlpha" — mounted at /api/auth/ipalpha (see README → IPAlpha).
 *
 *   GET  /config    public: is the button shown, and where the popup lives
 *   POST /start     PAR server-side (client secret + PKCE) → popup URL
 *   POST /complete  the popup's web_message { code, state } → Acampa session
 *
 * The person token is verified locally, used once (phone read on the first
 * login only) and dropped: never stored, cached, logged or returned.
 */
const ipalphaRoutes = new Hono();

const DISABLED_ERROR = { code: "IPALPHA_DISABLED", message: "O login IPAlpha não está disponível." };
const STATE_INVALID_ERROR = { code: "IPALPHA_STATE_INVALID", message: "Este login expirou. Tente entrar de novo." };
const CODE_INVALID_ERROR = { code: "IPALPHA_CODE_INVALID", message: "Não foi possível confirmar o login IPAlpha. Tente entrar de novo." };
const DENIED_ERROR = { code: "IPALPHA_DENIED", message: "O acesso não foi autorizado no IPAlpha." };

const RATE_LIMITED_ERROR = { code: "IPALPHA_RATE_LIMITED", message: "Muitas tentativas seguidas. Aguarde um instante e tente de novo." };

const PERSON_HINT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/token` answers that mean core refused OUR request (client credentials,
 * grant type, params we built) — a deploy problem, never the person's code.
 * `invalid_grant` (wrong / used / mismatched code) stays IPALPHA_CODE_INVALID.
 */
const TOKEN_CONFIG_ERRORS = new Set([
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
  "unsupported_grant_type",
  "unsupported_grant_for_entry_point",
  "invalid_target",
  "invalid_scope",
]);

/**
 * `/start` per-IP limit (each call writes a login state and a PAR at core):
 * fixed 1-minute window, in memory (per pod — a cheap brake, not a quota).
 */
const START_LIMIT = 20;
const START_WINDOW_MS = 60_000;
const startHits = new Map<string, { count: number; resetAt: number }>();

function startAllowed(ip: string, now = Date.now()): { ok: true } | { ok: false; secondsLeft: number } {
  if (startHits.size > 10_000) for (const [key, hit] of startHits) if (hit.resetAt <= now) startHits.delete(key);
  const hit = startHits.get(ip);
  if (!hit || hit.resetAt <= now) {
    startHits.set(ip, { count: 1, resetAt: now + START_WINDOW_MS });
    return { ok: true };
  }
  if (hit.count >= START_LIMIT) return { ok: false, secondsLeft: Math.max(1, Math.ceil((hit.resetAt - now) / 1000)) };
  hit.count++;
  return { ok: true };
}

/** tests only */
export function resetStartRateLimit(): void {
  startHits.clear();
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The Acampa account behind the person's VERIFIED IPAlpha phones: an existing
 * account first, else roster / guardian provisioning (same as the phone
 * login). Unverified phones are ignored — they prove nothing.
 */
async function accountForPhones(phones: PhoneEntry[]): Promise<User | null> {
  const verified = [...new Set(phones.filter((p) => p.verified).map((p) => normalizeBrazilPhone(p.e164)).filter((p): p is string => !!p))];
  for (const phone of verified) {
    const user = await resolveAccountByPhone(phone);
    if (user) return user;
  }
  return null;
}

ipalphaRoutes.get("/config", (c) => {
  const cfg = ipalpha.config;
  c.header("Cache-Control", "no-store");
  if (!cfg.enabled) return c.json({ enabled: false, authOrigin: null, clientId: null, entryPoint: null });
  return c.json({ enabled: true, authOrigin: cfg.authOrigin, clientId: cfg.clientId, entryPoint: cfg.entryPoint });
});

ipalphaRoutes.post("/start", async (c) => {
  if (!ipalphaEnabled()) return c.json({ error: DISABLED_ERROR }, 404);
  const limit = startAllowed(clientIp(c) ?? "unknown");
  if (!limit.ok) {
    c.header("Retry-After", String(limit.secondsLeft));
    return c.json({ error: { ...RATE_LIMITED_ERROR, secondsLeft: limit.secondsLeft } }, 429);
  }
  const body = await c.req.json<{ personHint?: unknown }>().catch(() => null);
  // the One Tap row the person picked (preselects that account in the popup); anything odd is just dropped
  const personHint = typeof body?.personHint === "string" && PERSON_HINT.test(body.personHint) ? body.personHint : undefined;

  const state = randomToken();
  const codeVerifier = randomToken();
  await saveLoginState(state, codeVerifier);
  try {
    const { url } = await coreClient().startAuthorization({ state, codeChallenge: s256(codeVerifier), personHint });
    c.header("Cache-Control", "no-store");
    // `state` lets the SPA match the popup's reply; the one-time server check stays the real guard
    return c.json({ url, state });
  } catch (err) {
    await consumeLoginState(state);
    // every PAR parameter is ours (client, secret, entry point, redirect, resource, project; the hint is pre-validated):
    // a 4xx is a deploy problem, not maintenance
    if (err instanceof IpalphaRejected) {
      console.error(`[ipalpha] PAR refused — check the IPALPHA_* configuration (${err.status} ${err.oauthError ?? "-"} ${err.reason})`);
      return c.json({ error: MISCONFIGURED_ERROR }, 500);
    }
    if (!(err instanceof IpalphaUnavailable)) console.error("[ipalpha] start failed", err);
    else console.warn(`[ipalpha] PAR failed (${err.message})`);
    return c.json({ error: UNAVAILABLE_ERROR }, 503);
  }
});

ipalphaRoutes.post("/complete", async (c) => {
  if (!ipalphaEnabled()) return c.json({ error: DISABLED_ERROR }, 404);
  const body = await c.req.json<{ code?: unknown; state?: unknown; error?: unknown; locale?: string }>().catch(() => null);
  const deviceLocale = resolveLocale(body?.locale ?? c.req.header("accept-language"));

  // one-time: a replayed, unknown or stale state is refused before anything else
  const stored = await consumeLoginState(typeof body?.state === "string" ? body.state : "");
  if (!stored) return c.json({ error: STATE_INVALID_ERROR }, 400);

  // the popup answered with an error (the person closed / refused consent)
  if (typeof body?.error === "string" && body.error) return c.json({ error: DENIED_ERROR }, 403);
  const code = typeof body?.code === "string" ? body.code : "";
  if (!code) return c.json({ error: CODE_INVALID_ERROR }, 400);

  const client = coreClient();
  let personToken: string;
  let personId: string;
  let sessionIdleHours: number | null;
  try {
    ({ token: personToken, sessionIdleHours } = await client.exchangeCode({ code, codeVerifier: stored.codeVerifier }));
    ({ personId } = await client.verifyPersonsToken(personToken));
  } catch (err) {
    if (err instanceof IpalphaRejected && err.oauthError && TOKEN_CONFIG_ERRORS.has(err.oauthError)) {
      console.error(`[ipalpha] code exchange refused — check the IPALPHA_* configuration (${err.status} ${err.oauthError} ${err.reason})`);
      return c.json({ error: MISCONFIGURED_ERROR }, 500);
    }
    if (err instanceof IpalphaRejected) {
      const denied = [err.reason, err.oauthError].some((r) => r === "access_denied" || r === "personsResourceMissing");
      console.warn(`[ipalpha] code exchange refused (${err.status} ${err.reason})`);
      return denied ? c.json({ error: DENIED_ERROR }, 403) : c.json({ error: CODE_INVALID_ERROR }, 400);
    }
    if (err instanceof IpalphaTokenInvalid) {
      console.warn(`[ipalpha] person token rejected (${err.message})`);
      return c.json({ error: CODE_INVALID_ERROR }, 400);
    }
    if (!(err instanceof IpalphaUnavailable)) console.error("[ipalpha] complete failed", err);
    return c.json({ error: UNAVAILABLE_ERROR }, 503);
  }

  // a known person goes straight in; the phone is read (fresh) only the first time
  let user = await findByPersonId(personId);
  if (!user) {
    let phones: PhoneEntry[] = [];
    try {
      phones = await client.readPhones(personId, personToken);
    } catch (err) {
      if (!(err instanceof IpalphaRejected)) return c.json({ error: UNAVAILABLE_ERROR }, 503);
      // no consent to the phone / no person record: nothing proves an Acampa account
      console.warn(`[ipalpha] phone read refused (${err.status} ${err.reason})`);
    }
    user = await accountForPhones(phones);
    if (!user) return c.json({ error: NO_PROFILE_ERROR }, 403);
    await bindPersonId(user, personId);
  }

  // the same gates as the phone + code login
  const { role, available } = await landingRole(user);
  if (available.length === 0) return c.json({ error: NO_PROFILE_ERROR }, 403);
  const frozen = frozenError(user);
  if (frozen) return c.json({ error: frozen }, 423);
  const windowErr = await staffWindowError(user.phone, role);
  if (windowErr) return c.json({ error: windowErr }, 403);

  // session length: the entry point's `session_idle_hours` from this very token answer (absent → SESSION_HOURS)
  return c.json(await completeLogin(user, role, available, deviceLocale, sessionIdleHours ?? undefined));
});

export default ipalphaRoutes;
