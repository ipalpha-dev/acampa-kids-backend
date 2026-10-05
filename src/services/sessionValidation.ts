import type { CoreRole } from "../types";

/**
 * A successful role check, remembered in this process only (decision 70: id
 * relations). `validateSessionRole` runs on every request and every realtime
 * recipient — three core calls each time. The memo holds `sessionId|role|campId
 * → validatedAt` and nothing else (no tokens, no names), for about 15 s, so a
 * membership removed in core stops granting access within 15 s at most.
 * A 401 still ends the session at once, and any failed check (a removed
 * membership included) drops the memo too — so the next recipient is asked
 * again immediately. Logout and role switch clear it as well. It is never
 * written when the check fails.
 */
const VALIDATION_MS = 15_000;
const memo = new Map<string, number>();

function key(sessionId: string, role: CoreRole, campId: string): string {
  return `${sessionId}|${role}|${campId}`;
}

/** True when a successful check is still inside the window. */
export function rememberedValidation(sessionId: string, role: CoreRole, campId: string): boolean {
  const at = memo.get(key(sessionId, role, campId));
  return at !== undefined && Date.now() - at < VALIDATION_MS;
}

/** Remembers a check that just succeeded (ids only). */
export function rememberValidation(sessionId: string, role: CoreRole, campId: string): void {
  if (memo.size > 5000) memo.clear();
  memo.set(key(sessionId, role, campId), Date.now());
}

/** Drops every remembered check of a session (logout, revoke, role switch, a failed check). */
export function forgetSessionValidation(sessionId: string): void {
  const prefix = `${sessionId}|`;
  for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k);
}

/** tests only */
export function clearValidationMemo(): void {
  memo.clear();
}
