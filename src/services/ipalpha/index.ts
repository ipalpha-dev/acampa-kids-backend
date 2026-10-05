import { config, type IpalphaConfig } from "../../config";
import type { Locale } from "../../i18n";
import { createIpalphaCoreClient, IpalphaRejected, IpalphaUnavailable, type IpalphaCoreClient } from "./coreClient";

export { IpalphaRejected, IpalphaTokenInvalid, IpalphaTokenRevoked, IpalphaUnavailable } from "./coreClient";

/**
 * The IPAlpha runtime: the config read at boot and the core client built from
 * it. A plain mutable holder — tests swap `config` / `client` for fakes.
 */
export const ipalpha: { config: IpalphaConfig; client: IpalphaCoreClient | null } = {
  config: config.ipalpha,
  client: null,
};

export function ipalphaEnabled(): boolean {
  return ipalpha.config.enabled;
}

export function coreClient(): IpalphaCoreClient {
  ipalpha.client ??= createIpalphaCoreClient(ipalpha.config);
  return ipalpha.client;
}

/** Acampa's device locale → auth-api's language tag (SMS language). */
export function authLanguage(locale: Locale): string {
  return ({ pt: "pt-BR", en: "en-US", es: "es", fr: "fr", de: "de" } as Record<string, string>)[locale] ?? "pt-BR";
}

export const UNAVAILABLE_ERROR = {
  code: "IPALPHA_UNAVAILABLE",
  message: "O login está em manutenção. Tente novamente em instantes.",
} as const;

/** core refused OUR request (credentials, entry point, params) — a deploy problem, not an outage (500, logged) */
export const MISCONFIGURED_ERROR = {
  code: "IPALPHA_MISCONFIGURED",
  message: "O login IPAlpha não está disponível agora. Tente novamente mais tarde.",
} as const;

/** unknown person, or a person without any live role in the Acampa project (§10/§15) */
export const NOT_IN_PROJECT_ERROR = {
  code: "NOT_IN_PROJECT",
  message: "Não encontramos seu cadastro neste acampamento.",
} as const;

/**
 * What the phone + code routes answer for an auth-api relay rejection:
 *
 *   personNotFound / notInProject   → 404 NOT_IN_PROJECT (start answers the same for both — §10)
 *   invalidCode                     → 400 OTP_INVALID (+ attemptsLeft when auth sent one)
 *   tryAgainLater / tooManyAttempts → verify: 423 ACCOUNT_FROZEN (+ minutesLeft) — auth-api's lockout (loginPolicy)
 *                                     request: 429 OTP_COOLDOWN (+ secondsLeft)
 *   tooManyRequests / resendTooSoon → 429 OTP_COOLDOWN (+ secondsLeft)
 *   challengeExpired                → 400 OTP_EXPIRED
 *   anything else                   → 503 IPALPHA_UNAVAILABLE
 *
 * No local fallback: Acampa never sends a code itself (§15).
 */
export interface RelayError {
  status: 400 | 404 | 423 | 429 | 503;
  error: Record<string, unknown> & { code: string; message: string };
}

const DEFAULT_COOLDOWN_SEC = 60;
const DEFAULT_LOCK_MINUTES = 15;

function cooldown(retryAfterSec: number | null): RelayError {
  const secondsLeft = Math.ceil(retryAfterSec ?? DEFAULT_COOLDOWN_SEC);
  return { status: 429, error: { code: "OTP_COOLDOWN", message: `Aguarde ${secondsLeft}s para pedir um novo código.`, secondsLeft } };
}

export function mapRelayError(phase: "request" | "verify", err: unknown): RelayError {
  if (err instanceof IpalphaUnavailable || !(err instanceof IpalphaRejected)) return { status: 503, error: { ...UNAVAILABLE_ERROR } };
  const retryAfterSec = typeof err.body.retryAfterSec === "number" && err.body.retryAfterSec > 0 ? err.body.retryAfterSec : null;
  switch (err.reason) {
    case "personNotFound":
    case "notInProject":
      return { status: 404, error: { ...NOT_IN_PROJECT_ERROR } };
    case "invalidCode": {
      const attemptsLeft = typeof err.body.attemptsLeft === "number" ? err.body.attemptsLeft : undefined;
      return { status: 400, error: { code: "OTP_INVALID", message: "Código incorreto.", ...(attemptsLeft !== undefined ? { attemptsLeft } : {}) } };
    }
    case "tryAgainLater":
    case "tooManyAttempts": {
      if (phase === "request") return cooldown(retryAfterSec);
      const minutesLeft = retryAfterSec ? Math.max(1, Math.ceil(retryAfterSec / 60)) : DEFAULT_LOCK_MINUTES;
      return { status: 423, error: { code: "ACCOUNT_FROZEN", message: `Muitas tentativas incorretas. Tente novamente em ${minutesLeft} minuto(s).`, minutesLeft } };
    }
    case "tooManyRequests":
    case "resendTooSoon":
      return cooldown(retryAfterSec);
    case "challengeExpired":
      return { status: 400, error: { code: "OTP_EXPIRED", message: "O código expirou. Peça um novo código." } };
    case "invalidPhone":
      return { status: 400, error: { code: "PHONE_INVALID", message: "Informe um celular brasileiro válido com DDD." } };
  }
  console.warn(`[ipalpha] relay ${phase} rejected (${err.status} ${err.reason}) — answered as unavailable`);
  return { status: 503, error: { ...UNAVAILABLE_ERROR } };
}

/**
 * Camp activated → the matching edition of the Acampa project becomes current
 * in projects-api (`current-by-year`). Best effort: logged, never thrown, never
 * blocks the activation. Returns the edition id when core answered one.
 */
export async function rolloverEdition(year: number): Promise<{ status: "skipped" | "ok" | "failed"; editionId: string | null }> {
  if (!ipalpha.config.enabled) return { status: "skipped", editionId: null };
  try {
    const edition = await coreClient().markCurrentEdition(year);
    console.log(`[ipalpha] edition ${year} marked current`);
    return { status: "ok", editionId: edition?.id ?? null };
  } catch (err) {
    const why = err instanceof IpalphaRejected ? `${err.status} ${err.reason}` : err instanceof IpalphaUnavailable ? "unavailable" : "error";
    console.warn(`[ipalpha] edition ${year} rollover failed (${why}) — the camp stays active`);
    return { status: "failed", editionId: null };
  }
}

/** Boot log: which variables are missing (names only, never values). */
export function logIpalphaStatus(): void {
  const cfg = ipalpha.config;
  if (cfg.enabled) {
    console.log("IPAlpha core configured: sign-in, people, roles and messages come from core.");
    return;
  }
  console.warn(`⚠️  IPAlpha core NOT configured — nobody can sign in. Missing: ${cfg.missing.join(", ")}.`);
}
