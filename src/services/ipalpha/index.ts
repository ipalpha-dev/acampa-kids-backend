import { config, type IpalphaConfig } from "../../config";
import type { Locale } from "../../i18n";
import { createIpalphaCoreClient, IpalphaRejected, IpalphaUnavailable, type IpalphaCoreClient } from "./coreClient";

export { IpalphaRejected, IpalphaTokenInvalid, IpalphaUnavailable } from "./coreClient";

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

/**
 * The session length auth-api configures for Acampa's entry point
 * (`sessionIdleHours`, edited in Mordomia). Learned from every relay answer
 * (app configuration, not person data); until one arrives the local
 * `SESSION_HOURS` (default 96, auth's own default) is used.
 */
let learnedSessionIdleHours: number | null = null;

export function rememberSessionIdleHours(hours: number | null): void {
  if (hours !== null) learnedSessionIdleHours = hours;
}

export function sessionIdleHours(): number {
  return learnedSessionIdleHours ?? config.sessionHours;
}

/** tests only: forget what relay answers taught */
export function resetSessionIdleHours(): void {
  learnedSessionIdleHours = null;
}

/** Acampa's device locale → auth-api's language tag (SMS language). */
export function authLanguage(locale: Locale): string {
  return ({ pt: "pt-BR", en: "en-US", es: "es", fr: "fr" } as Record<string, string>)[locale] ?? "pt-BR";
}

export const UNAVAILABLE_ERROR = {
  code: "IPALPHA_UNAVAILABLE",
  message: "O login está em manutenção. Tente novamente em instantes.",
} as const;

/**
 * What the legacy OTP routes answer for an auth-api relay rejection (§5):
 *
 *   invalidCode                      → 400 OTP_INVALID (+ attemptsLeft when auth sent one)
 *   tryAgainLater / tooManyAttempts  → 423 ACCOUNT_FROZEN (+ minutesLeft); the account is frozen locally too
 *   tooManyRequests (per-IP limit)   → 429 OTP_COOLDOWN (+ secondsLeft) — the account is NOT frozen
 *   challengeExpired                 → 400 OTP_EXPIRED; the pending challenge is dropped
 *   resendTooSoon                    → 429 OTP_COOLDOWN (+ secondsLeft)
 *   personNotFound (request only)    → "fallback": the local SMS path runs (roster phones not in core yet)
 *   anything else                    → 503 IPALPHA_UNAVAILABLE (misconfiguration looks like an outage to the person)
 */
export type RelayOutcome =
  | { kind: "fallback" }
  | {
      kind: "error";
      status: 400 | 423 | 429 | 503;
      error: Record<string, unknown> & { code: string; message: string };
      /** freeze the account locally until now + this many minutes (and drop the pending code) */
      freezeMinutes?: number;
      /** drop the pending challenge */
      clearOtp?: boolean;
      /** count one more wrong attempt on the pending challenge */
      countAttempt?: boolean;
    };

export function mapRelayError(phase: "request" | "verify", err: unknown): RelayOutcome {
  if (err instanceof IpalphaUnavailable || !(err instanceof IpalphaRejected)) {
    return { kind: "error", status: 503, error: { ...UNAVAILABLE_ERROR } };
  }
  const retryAfterSec = typeof err.body.retryAfterSec === "number" && err.body.retryAfterSec > 0 ? err.body.retryAfterSec : null;
  switch (err.reason) {
    case "personNotFound":
      if (phase === "request") return { kind: "fallback" };
      break;
    case "invalidCode": {
      const attemptsLeft = typeof err.body.attemptsLeft === "number" ? err.body.attemptsLeft : undefined;
      return {
        kind: "error",
        status: 400,
        error: { code: "OTP_INVALID", message: "Código incorreto.", ...(attemptsLeft !== undefined ? { attemptsLeft } : {}) },
        countAttempt: true,
      };
    }
    case "tryAgainLater":
    case "tooManyAttempts": {
      const minutesLeft = retryAfterSec ? Math.max(1, Math.ceil(retryAfterSec / 60)) : config.otp.freezeMinutes;
      return {
        kind: "error",
        status: 423,
        error: {
          code: "ACCOUNT_FROZEN",
          message: `Conta bloqueada por tentativas incorretas. Tente novamente em ${minutesLeft} minuto(s).`,
          minutesLeft,
        },
        freezeMinutes: minutesLeft,
      };
    }
    case "tooManyRequests":
    case "resendTooSoon": {
      const secondsLeft = Math.ceil(retryAfterSec ?? config.otp.resendCooldownSeconds);
      return { kind: "error", status: 429, error: { code: "OTP_COOLDOWN", message: `Aguarde ${secondsLeft}s para pedir um novo código.`, secondsLeft } };
    }
    case "challengeExpired":
      return { kind: "error", status: 400, error: { code: "OTP_EXPIRED", message: "O código expirou. Peça um novo código." }, clearOtp: true };
  }
  console.warn(`[ipalpha] relay ${phase} rejected (${err.status} ${err.reason}) — answered as unavailable`);
  return { kind: "error", status: 503, error: { ...UNAVAILABLE_ERROR } };
}

/**
 * Camp activated → the matching edition of the Acampa project becomes current
 * in projects-api (`current-by-year`). Best effort: logged, never thrown, never
 * blocks the activation.
 */
export async function rolloverEdition(year: number): Promise<"skipped" | "ok" | "failed"> {
  const cfg = ipalpha.config;
  if (!cfg.enabled || !cfg.projectId) return "skipped";
  if (!cfg.projectsApiUrl) {
    console.warn("[ipalpha] edition rollover skipped: IPALPHA_PROJECTS_API_URL is not set");
    return "skipped";
  }
  try {
    await coreClient().markCurrentEdition(year);
    console.log(`[ipalpha] edition ${year} marked current`);
    return "ok";
  } catch (err) {
    const why = err instanceof IpalphaRejected ? `${err.status} ${err.reason}` : err instanceof IpalphaUnavailable ? "unavailable" : "error";
    console.warn(`[ipalpha] edition ${year} rollover failed (${why}) — the camp stays active`);
    return "failed";
  }
}

/** Boot log: which variables are missing (names only, never values). */
export function logIpalphaStatus(): void {
  const cfg = ipalpha.config;
  if (cfg.enabled) {
    console.log(`IPAlpha login enabled${cfg.projectId ? " (project-scoped)" : ""}; legacy phone login relays through auth-api.`);
    if (cfg.projectId && !cfg.projectsApiUrl) console.warn("⚠️  IPALPHA_PROJECT_ID set without IPALPHA_PROJECTS_API_URL — edition rollover is off.");
    return;
  }
  console.log(`IPAlpha login disabled — missing: ${cfg.missing.join(", ")}.`);
}
