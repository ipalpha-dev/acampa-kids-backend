import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { resolveLocale } from "../i18n";
import { findByPersonId } from "../models/users";
import { consumeLoginState, saveLoginState } from "../models/ipalphaLoginStates";
import { coreClient, ipalpha, ipalphaEnabled, IpalphaRejected, IpalphaTokenInvalid, IpalphaUnavailable, sessionIdleHours, UNAVAILABLE_ERROR } from "../services/ipalpha";
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

const PERSON_HINT = /^[A-Za-z0-9_-]{1,64}$/;

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
    const why = err instanceof IpalphaRejected ? `${err.status} ${err.reason}` : "unavailable";
    console.warn(`[ipalpha] PAR failed (${why})`);
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
  try {
    personToken = await client.exchangeCode({ code, codeVerifier: stored.codeVerifier });
    ({ personId } = await client.verifyPersonsToken(personToken));
  } catch (err) {
    if (err instanceof IpalphaRejected) {
      const denied = err.reason === "access_denied" || err.reason === "personsResourceMissing";
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

  return c.json(await completeLogin(user, role, available, deviceLocale, sessionIdleHours()));
});

export default ipalphaRoutes;
