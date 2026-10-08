import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "../types";

/**
 * The session a request (or a realtime payload, or work it queued) acts for. Core reads that need a person's
 * role token — names (`seesPersonsOf`), member lists, the editions list — take the token from here. No viewer
 * (a timer, a webhook) = no role token: those paths drop the read (names) or go through notifications-api
 * `audience` (member lists).
 */
const storage = new AsyncLocalStorage<Session>();

export function withViewer<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  return storage.run(session, fn);
}

/** `fn` acting for `session`, or for nobody (null) even when the caller had a viewer. */
export function withViewerOf<T>(session: Session | null, fn: () => Promise<T>): Promise<T> {
  return session ? storage.run(session, fn) : storage.exit(fn);
}

export function currentViewer(): Session | null {
  return storage.getStore() ?? null;
}
