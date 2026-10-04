import { Hono, type Context } from "hono";
import { config } from "../config";
import { resolveLocale, sms, smsPrefix, type Locale } from "../i18n";
import { findByPhone, toPublicUser, updateUser } from "../models/users";
import { availableRolesOf } from "../services/roles";
import { comteleEnabled, comteleSendSms, resolveSmsTarget } from "../services/comtele";
import { generateLocalCode, hashCode, verifyLocalCode } from "../services/otp";
import { replaceSession, revokeSession } from "../services/session";
import { clientIp } from "../services/clientIp";
import type { PublicUser, Role, SessionUser, User } from "../types";
import { formatBrazilPhone, isRole, normalizeBrazilPhone } from "../utils";
import { requireAuth } from "../middleware/auth";
import { withCamp } from "../services/campContext";
import { findCamp } from "../models/camps";
import { canSwitchCamps, switchableCamps } from "../services/campAccess";
import { NO_PROFILE_ERROR, bindPersonId, completeLogin, frozenError, landingRole, resolveAccountByPhone, sessionCamp, staffWindowError } from "../services/login";
import { authLanguage, coreClient, ipalphaEnabled, mapRelayError, type RelayOutcome } from "../services/ipalpha";
import ipalphaRoutes from "./ipalpha";

interface AuthEnv {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
    campId: string;
  };
}

const auth = new Hono<AuthEnv>();

// "Entrar com IPAlpha": /api/auth/ipalpha/{config,start,complete}
auth.route("/ipalpha", ipalphaRoutes);

function minutesOf(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** Local side effects of a relay rejection (freeze / drop the challenge / count the attempt) — see mapRelayError. */
async function applyRelayOutcome(user: User, outcome: Extract<RelayOutcome, { kind: "error" }>): Promise<void> {
  if (outcome.freezeMinutes) {
    await updateUser(user._id, { otp: null, frozenUntil: new Date(Date.now() + outcome.freezeMinutes * 60 * 1000) });
    console.warn(`[auth] Account frozen for ${outcome.freezeMinutes}min by IPAlpha: account ${user._id}`);
  } else if (outcome.clearOtp) {
    await updateUser(user._id, { otp: null });
  } else if (outcome.countAttempt && user.otp) {
    await updateUser(user._id, { otp: { ...user.otp, attempts: user.otp.attempts + 1 } });
  }
}

/**
 * IPAlpha relay of the code request (auth-api generates and sends the code).
 * Returns the response, or null when auth-api does not know this phone
 * (`personNotFound`) — the caller then keeps today's local SMS path.
 */
async function relayOtpRequest(c: Context, user: User, phone: string, role: Role, available: Role[], deviceLocale: Locale): Promise<Response | null> {
  // a relayed code sent moments ago and still valid (e.g. the person went back
  // and re-entered the phone): don't ask core again — reuse it, as the local path does
  if (user.otp?.provider === "ipalpha" && user.otp.challengeId) {
    const secondsSince = (Date.now() - user.otp.requestedAt.getTime()) / 1000;
    if (secondsSince < config.otp.resendCooldownSeconds && user.otp.expiresAt > new Date() && user.otp.attempts < config.otp.maxAttempts) {
      return c.json({
        success: true,
        phone,
        role,
        roles: available,
        expiresAt: user.otp.expiresAt.toISOString(),
        expireMinutes: minutesOf(user.otp.expiresAt.getTime() - user.otp.requestedAt.getTime()),
        delivery: "sms",
        reused: true,
      });
    }
  }

  let answer;
  try {
    answer = await coreClient().relayStart({ phone, language: authLanguage(user.locale || deviceLocale), clientIp: clientIp(c) });
  } catch (err) {
    const outcome = mapRelayError("request", err);
    if (outcome.kind === "fallback") return null;
    await applyRelayOutcome(user, outcome);
    return c.json({ error: outcome.error }, outcome.status);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + answer.expiresInSec * 1000);
  await updateUser(user._id, {
    otp: { provider: "ipalpha", challengeId: answer.challengeId, requestedRole: role, requestedAt: now, expiresAt, attempts: 0 },
  });
  console.log(`[ipalpha] login code relayed through IPAlpha for account ${user._id} (entrando como ${role})`);

  return c.json({
    success: true,
    phone,
    role,
    roles: available,
    expiresAt: expiresAt.toISOString(),
    expireMinutes: minutesOf(answer.expiresInSec * 1000),
    delivery: "sms",
  });
}

/** IPAlpha relay of the code check → the proven person id is bound and the session issued. */
async function relayOtpVerify(c: Context, user: User, code: string, role: Role, available: Role[], deviceLocale: Locale): Promise<Response> {
  const challengeId = user.otp?.challengeId;
  if (!ipalphaEnabled() || !challengeId) {
    // IPAlpha was switched off while this code was pending
    await updateUser(user._id, { otp: null });
    return c.json({ error: { code: "OTP_EXPIRED", message: "O código expirou. Peça um novo código." } }, 400);
  }
  let answer;
  try {
    answer = await coreClient().relayVerify({ challengeId, code });
  } catch (err) {
    const outcome = mapRelayError("verify", err);
    if (outcome.kind === "fallback") return c.json({ error: { code: "OTP_EXPIRED", message: "O código expirou. Peça um novo código." } }, 400);
    await applyRelayOutcome(user, outcome);
    return c.json({ error: outcome.error }, outcome.status);
  }
  await bindPersonId(user, answer.personId);
  // session length: what auth-api answered for THIS login (absent → SESSION_HOURS)
  return c.json(await completeLogin(user, role, available, deviceLocale, answer.sessionIdleHours ?? undefined));
}

/**
 * The same person can hold multiple roles (parent + staff + admin).
 * Login flow: phone number only. The first session uses the highest role; the
 * frontend asks which profile to keep before opening the application whenever
 * this array contains more than one role.
 *
 * With IPAlpha configured the code is generated and sent by auth-api (relay);
 * phones auth-api does not know yet keep the local SMS path below.
 */
auth.post("/otp/request", async (c) => {
  const body = await c.req.json<{ phone?: string; locale?: string }>().catch(() => null);
  const deviceLocale = resolveLocale(body?.locale ?? c.req.header("accept-language"));

  const phone = body?.phone ? normalizeBrazilPhone(body.phone) : null;
  if (!phone) {
    return c.json(
      { error: { code: "PHONE_INVALID", message: "Informe um celular brasileiro válido com DDD." } },
      400,
    );
  }

  // look up the PERSON by phone (unique). Roster / guardian phones may not
  // have a users doc yet (the admin form never created one) — provision it.
  const user = await resolveAccountByPhone(phone);
  if (!user) {
    return c.json(
      {
        error: {
          code: "USER_NOT_FOUND",
          message: "Nenhum cadastro encontrado para este telefone.",
        },
      },
      404,
    );
  }
  const { role, available } = await landingRole(user);
  // the account exists but the data gives it no profile (e.g. an ex-responsible
  // whose kid is not enrolled this year): say so instead of sending a useless code
  if (available.length === 0) {
    return c.json({ error: NO_PROFILE_ERROR }, 403);
  }

  // frozen account?
  const frozen = frozenError(user);
  if (frozen) return c.json({ error: frozen }, 423);

  // ordinary team members: only inside the staff access window
  const windowErr = await staffWindowError(phone, role);
  if (windowErr) return c.json({ error: windowErr }, 403);

  if (ipalphaEnabled()) {
    const relayed = await relayOtpRequest(c, user, phone, role, available, deviceLocale);
    if (relayed) return relayed;
  }

  // resend cooldown (local codes only — a relayed challenge is auth-api's to throttle)
  if (user.otp && user.otp.provider !== "ipalpha") {
    const secondsSince = (Date.now() - user.otp.requestedAt.getTime()) / 1000;
    if (secondsSince < config.otp.resendCooldownSeconds) {
      // a code was sent moments ago and is still valid (e.g. user went back
      // and re-entered the phone): don't block — reuse the last code sent
      if (user.otp.expiresAt > new Date() && user.otp.attempts < config.otp.maxAttempts) {
        return c.json({
          success: true,
          phone,
          role,
          roles: available,
          expiresAt: user.otp.expiresAt.toISOString(),
          expireMinutes: config.otp.expireMinutes,
          delivery: user.otp.provider === "comtele" ? "sms" : "mock",
          reused: true,
        });
      }

      const secondsLeft = Math.ceil(config.otp.resendCooldownSeconds - secondsSince);
      return c.json(
        {
          error: {
            code: "OTP_COOLDOWN",
            message: `Aguarde ${secondsLeft}s para pedir um novo código.`,
            secondsLeft,
          },
        },
        429,
      );
    }
  }

  // send the code
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.otp.expireMinutes * 60 * 1000);

  // the code is ALWAYS generated here (so it can be logged and verified
  // locally); Comtele only delivers it by SMS when configured
  const code = generateLocalCode();
  const viaSms = comteleEnabled();
  // SMS redirect (Settings → Testes): the team's codes go to the staff test phone, the parents' to the parent one; admins always get their own
  const target = role === "admin" ? { phone, redirected: false } : await resolveSmsTarget(phone, role === "parent" ? "parent" : "staff");
  if (!target) {
    return c.json({ error: { code: "SMS_REDIRECT_UNSET", message: "O redirecionamento de SMS está ligado sem um celular de teste para este perfil. Ajuste em Configurações → Testes." } }, 503);
  }

  // SMS language: last saved locale on the account, else the device language of this request
  const smsLocale: Locale = user.locale || deviceLocale;
  if (viaSms) {
    const result = await comteleSendSms(
      target.phone,
      sms(smsLocale, "otp", { prefix: smsPrefix(), code, minutes: config.otp.expireMinutes }),
    );
    if (!result.ok) {
      console.error("[comtele] send failed:", result.message);
      return c.json(
        {
          error: {
            code: "SMS_SEND_FAILED",
            message: "Não foi possível enviar o SMS agora. Tente novamente em instantes.",
          },
        },
        502,
      );
    }
  }

  console.log(
    `\n📩 [OTP${viaSms ? " · SMS" : " · DEV MOCK"}] ${user.name} — ${formatBrazilPhone(phone)}${target.redirected ? ` → redirect ${formatBrazilPhone(target.phone)}` : ""} (entrando como ${role}): ${code}\n`,
  );

  await updateUser(user._id, {
    otp: {
      provider: viaSms ? "comtele" : "local",
      codeHash: hashCode(code),
      requestedRole: role,
      requestedAt: now,
      expiresAt,
      attempts: 0,
    },
  });

  return c.json({
    success: true,
    phone,
    role,
    roles: available,
    expiresAt: expiresAt.toISOString(),
    expireMinutes: config.otp.expireMinutes,
    // "redirect": the code went to the admin's test phone (Settings → Testes), not to this number
    delivery: target.redirected ? "redirect" : comteleEnabled() ? "sms" : "mock",
  });
});

auth.post("/otp/verify", async (c) => {
  const body = await c.req.json<{ phone?: string; code?: string; locale?: string }>().catch(() => null);
  const deviceLocale = resolveLocale(body?.locale ?? c.req.header("accept-language"));

  const phone = body?.phone ? normalizeBrazilPhone(body.phone) : null;
  const code = (body?.code ?? "").replace(/\D/g, "");

  if (!phone) {
    return c.json(
      { error: { code: "PHONE_INVALID", message: "Telefone inválido." } },
      400,
    );
  }
  if (code.length !== config.otp.length) {
    return c.json(
      { error: { code: "OTP_INVALID_FORMAT", message: `Informe os ${config.otp.length} dígitos do código.` } },
      400,
    );
  }

  const user = await findByPhone(phone);
  if (!user) {
    return c.json(
      { error: { code: "USER_NOT_FOUND", message: "Cadastro não encontrado." } },
      404,
    );
  }
  const { role, available } = await landingRole(user);
  // the profile may have vanished between the request and the verify
  if (available.length === 0) {
    return c.json({ error: NO_PROFILE_ERROR }, 403);
  }

  // frozen?
  const frozen = frozenError(user);
  if (frozen) return c.json({ error: frozen }, 423);

  if (!user.otp) {
    return c.json(
      { error: { code: "OTP_NOT_REQUESTED", message: "Peça um código primeiro." } },
      400,
    );
  }

  // window may have closed between request and verify
  const windowErr = await staffWindowError(phone, role);
  if (windowErr) return c.json({ error: windowErr }, 403);

  // expired?
  if (user.otp.expiresAt <= new Date()) {
    return c.json(
      {
        error: {
          code: "OTP_EXPIRED",
          message: "O código expirou. Peça um novo código.",
        },
      },
      400,
    );
  }

  // a code relayed through IPAlpha is checked by auth-api
  if (user.otp.provider === "ipalpha") return relayOtpVerify(c, user, code, role, available, deviceLocale);

  // validate the code (always generated and hashed on our side)
  const valid = !!user.otp.codeHash && verifyLocalCode(code, user.otp.codeHash);

  if (!valid) {
    const attempts = user.otp.attempts + 1;

    if (attempts >= config.otp.maxAttempts) {
      // freeze the account
      const frozenUntil = new Date(Date.now() + config.otp.freezeMinutes * 60 * 1000);
      await updateUser(user._id, { otp: null, frozenUntil });
      console.warn(
        `[auth] Account frozen for ${config.otp.freezeMinutes}min: ${formatBrazilPhone(phone)} (${user.roles.join(", ")})`,
      );
      return c.json(
        {
          error: {
            code: "ACCOUNT_FROZEN",
            message: `Código incorreto ${config.otp.maxAttempts}x. A conta foi bloqueada por ${config.otp.freezeMinutes} minutos.`,
            minutesLeft: config.otp.freezeMinutes,
          },
        },
        423,
      );
    }

    await updateUser(user._id, { otp: { ...user.otp, attempts } });
    const attemptsLeft = config.otp.maxAttempts - attempts;
    return c.json(
      {
        error: {
          code: "OTP_INVALID",
          message: "Código incorreto.",
          attemptsLeft,
        },
      },
      400,
    );
  }

  // success — clear OTP, unfreeze, remember device language, create session
  // a local code (IPAlpha off, or a roster phone core does not know yet): SESSION_HOURS
  return c.json(await completeLogin(user, role, available, deviceLocale));
});

/** Who am I? (requires Bearer token) */
auth.get("/me", requireAuth, async (c) => {
  const me = c.get("user");
  const camps = await switchableCamps(me, me.activeRole);
  return c.json({ user: { ...me, roles: await availableRolesOf(me) }, camp: await sessionCamp(c.get("campId")), ...(camps ? { camps } : {}) });
});

/**
 * POST /api/auth/role  { role } — the SAME person switching profile (a mãe
 * who is also on the team). No new SMS: the current session is revoked and a
 * fresh one is issued for the role asked for, which must be one the person
 * actually holds and whose access window is open right now.
 */
auth.post("/role", requireAuth, async (c) => {
  const body = await c.req.json<{ role?: unknown }>().catch(() => null);
  const role = body?.role;
  if (!isRole(role)) return c.json({ error: { code: "ROLE_INVALID", message: "Perfil inválido." } }, 400);
  const user = await findByPhone(c.get("user").phone);
  if (!user) return c.json({ error: { code: "USER_NOT_FOUND", message: "Cadastro não encontrado." } }, 404);
  const available = await availableRolesOf(user);
  if (!available.includes(role)) return c.json({ error: { code: "ROLE_FORBIDDEN", message: "Você não tem este perfil." } }, 403);
  // the target role's own access window (the team's / the parents')
  const windowErr = await staffWindowError(user.phone, role);
  if (windowErr) return c.json({ error: windowErr }, 403);

  // same length the session was opened with
  const { token, session } = await replaceSession(c.get("sessionId"), user._id, role, c.get("campId"));
  const camps = await switchableCamps(user, role);
  return c.json({
    success: true,
    token,
    tokenExpiresAt: session.expiresAt.toISOString(),
    user: { ...toPublicUser(user), roles: available, activeRole: role },
    camp: await sessionCamp(session.campId),
    ...(camps ? { camps } : {}),
  });
});

/**
 * POST /api/auth/camp  { campId } — a global admin or an ORGANIZER of the
 * active camp jumping to another year. Revokes the current session and issues
 * a new one, same role, in the target camp — which becomes a HISTORY session
 * the moment it isn't the active camp (read-only, forced admin reads).
 */
auth.post("/camp", requireAuth, async (c) => {
  const body = await c.req.json<{ campId?: unknown }>().catch(() => null);
  const campId = typeof body?.campId === "string" ? body.campId : "";
  const sessionUser = c.get("user");
  const activeRole = c.get("activeRole");

  if (!(await canSwitchCamps(sessionUser, activeRole))) {
    return c.json({ error: { code: "CAMP_FORBIDDEN", message: "Só a organização pode ver outros anos." } }, 403);
  }
  const target = campId ? await findCamp(campId) : null;
  if (!target) return c.json({ error: { code: "CAMP_NOT_FOUND", message: "Acampamento não encontrado." } }, 404);

  const user = await findByPhone(sessionUser.phone);
  if (!user) return c.json({ error: { code: "USER_NOT_FOUND", message: "Cadastro não encontrado." } }, 404);

  const { token, session } = await replaceSession(c.get("sessionId"), user._id, activeRole, target._id);
  const { available, camps } = await withCamp(target._id, async () => ({
    available: await availableRolesOf(user),
    camps: await switchableCamps(user, activeRole),
  }));

  return c.json({
    success: true,
    token,
    tokenExpiresAt: session.expiresAt.toISOString(),
    user: { ...toPublicUser(user), roles: available, activeRole },
    camp: await sessionCamp(session.campId),
    ...(camps ? { camps } : {}),
  });
});

/** Logout — revokes the session */
auth.post("/logout", requireAuth, async (c) => {
  await revokeSession(c.get("sessionId"));
  return c.json({ success: true });
});

export default auth;
export type { PublicUser };
