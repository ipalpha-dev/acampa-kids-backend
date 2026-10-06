import type { Context, Next } from "hono";
import { rawDb } from "../db";

/**
 * `GET /live` + `GET /ready` (workspace rule "boot never waits on a peer"):
 * the server listens BEFORE MongoDB connects; `/live` is always 200, `/ready`
 * is 200 only when Acampa's OWN infra is good — boot finished (Mongo
 * connected, indexes, the active camp) and Mongo answers a ping now.
 * IPAlpha core is a peer: never checked here (a core call fails at call
 * time). The dispatch app-channel socket is reported as INFO only.
 *
 * Indexes (decision 91): an index Mongo refuses never blocks boot nor makes
 * the pod unready — `/ready` stays 200 with `checks.indexes: "degraded"` while
 * Mongo answers, so the app keeps serving (see services/indexes.ts; the failed
 * names are in the boot log). Only Mongo itself being down answers 503.
 */

const PING_TIMEOUT_MS = 2_000;

const state = {
  booted: false,
  bootError: "",
  /** informative probes (never gate readiness) */
  info: new Map<string, () => string>(),
  /** `collection.indexName` of every index Mongo refused at boot (names only) */
  failedIndexes: new Set<string>(),
};

export function markBooted(): void {
  state.booted = true;
  state.bootError = "";
}

/** the last boot failure (a short message, no secrets) — boot keeps retrying */
export function markBootError(message: string): void {
  state.bootError = message;
}

/** An index Mongo refused (decision 91) — `/ready` says `indexes: "degraded"`, still 200. */
export function markIndexFailed(name: string): void {
  state.failedIndexes.add(name);
}

/** A new boot attempt re-creates every index: forget the previous attempt's failures. */
export function clearIndexFailures(): void {
  state.failedIndexes.clear();
}

export function isBooted(): boolean {
  return state.booted;
}

/** Adds an informative line to `/ready` (e.g. the dispatch socket state). */
export function registerInfo(name: string, read: () => string): void {
  state.info.set(name, read);
}

async function mongoOk(): Promise<boolean> {
  try {
    const db = await Promise.race([rawDb(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PING_TIMEOUT_MS))]);
    await Promise.race([db.command({ ping: 1 }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PING_TIMEOUT_MS))]);
    return true;
  } catch {
    return false;
  }
}

export function live(c: Context): Response {
  return c.json({ live: true });
}

export async function ready(c: Context): Promise<Response> {
  const mongo = state.booted ? await mongoOk() : false;
  const checks = {
    boot: state.booted ? "ok" : state.bootError ? "retrying" : "starting",
    mongo: mongo ? "ok" : "down",
    // never gates readiness: a missing index is slower / less guarded, not down (decision 91)
    indexes: state.failedIndexes.size ? "degraded" : "ok",
  };
  const info = Object.fromEntries([...state.info].map(([name, read]) => [name, read()]));
  const ok = state.booted && mongo;
  c.header("Cache-Control", "no-store");
  return c.json({ ready: ok, checks, info }, ok ? 200 : 503);
}

/** `/api/*` before boot finished: 503 STARTING (the camp context and indexes are not there yet). */
export async function bootGate(c: Context, next: Next): Promise<Response | void> {
  if (!state.booted) return c.json({ error: { code: "STARTING", message: "O acampamento está abrindo. Tente de novo em instantes." } }, 503);
  await next();
}

/** tests only */
export function resetReadiness(booted = false): void {
  state.booted = booted;
  state.bootError = "";
  state.info.clear();
  state.failedIndexes.clear();
}
