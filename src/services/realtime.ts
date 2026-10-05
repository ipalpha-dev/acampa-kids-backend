import type { WSContext } from "hono/ws";
import type { CheckinWindow, CoreRole, Role } from "../types";
import { todayInSaoPaulo } from "../utils";
import { activeCampId, currentCampId, withCamp } from "./campContext";

/**
 * Realtime hub: every logged-in client keeps a WebSocket open and receives
 *   - a full `snapshot` right after connecting, and
 *   - an `update` with the collections that changed after every write.
 * Payloads are whole collections of CAMP-OPS records (~150 kids, ~70 team
 * rows, ~40 rooms, ~50 events) — never names or health (CONTRACTS §15).
 */

export const COLLECTIONS = ["campers", "staff", "bedrooms", "categories", "transports", "teams", "scores", "roles", "events", "preparation", "instructions", "occurrences", "medications", "gallery", "settings"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export type Snapshot = Partial<Record<Collection, unknown>>;

export interface RealtimeClient {
  ws: WSContext;
  /** the audience (admin on a history session) */
  role: Role;
  /** the acting IPAlpha role */
  coreRole: CoreRole;
  /** payloads are personalised per person (own record, own room, own kids) */
  personId: string;
  sessionId: string;
  /** the camp this session (and every payload it receives) is scoped to */
  campId: string;
}

const clients = new Set<RealtimeClient>();

export function addClient(client: RealtimeClient): void {
  clients.add(client);
}

export function removeClient(client: RealtimeClient): void {
  clients.delete(client);
}

export function clientCount(): number {
  return clients.size;
}

function safeSend(client: RealtimeClient, payload: string): void {
  try {
    if (client.ws.readyState === 1) client.ws.send(payload);
  } catch {
    clients.delete(client);
  }
}

// ── publish (debounced so a burst of writes becomes one message) ───────────

/** collections pending a push, per camp — a write in one camp never re-sends another camp's clients */
const pending = new Map<string, Set<Collection>>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Call after any write: the named collections are re-read and pushed to the CURRENT camp's clients. */
export function publish(...names: Collection[]): void {
  let campId: string;
  try {
    campId = currentCampId();
  } catch {
    return; // no active camp cached yet (boot hasn't finished, or an isolated test with no clients anyway) — nothing to publish
  }
  const set = pending.get(campId) ?? new Set<Collection>();
  for (const n of names) set.add(n);
  pending.set(campId, set);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, 25);
}

async function flush(): Promise<void> {
  const byCamp = new Map(pending);
  pending.clear();
  if (byCamp.size === 0 || clients.size === 0) return;

  // lazy import: snapshot.ts imports the routes (serializers) and the routes import publish()
  const { loadCollections, snapshotKey } = await import("./snapshot");
  const at = new Date().toISOString();

  for (const [campId, names] of byCamp) {
    const campClients = [...clients].filter((c) => c.campId === campId);
    if (campClients.length === 0 || names.size === 0) continue;
    await withCamp(campId, async () => {
      // one payload per distinct view (role, or role+person for staff)
      const byKey = new Map<string, string | null>();
      for (const client of campClients) {
        const viewer = { activeRole: client.role, coreRole: client.coreRole, personId: client.personId };
        const key = snapshotKey(viewer);
        if (!byKey.has(key)) {
          try {
            const data = await loadCollections(viewer, [...names]);
            byKey.set(key, Object.keys(data).length ? JSON.stringify({ type: "update", at, data }) : null);
          } catch (err) {
            console.error("realtime: failed to build update", err);
            byKey.set(key, null);
          }
        }
        const payload = byKey.get(key);
        if (payload) safeSend(client, payload);
      }
    });
  }
}

/** targeted event, not a collection replace: one record's background review advanced */
export type AiReviewedKind = "camper" | "staff";
export type AiReviewedStatus = "structured" | "reviewed" | "error";

/**
 * Tells every connected client about one record's background AI review:
 * "structured" = the fast Jev pass wrote the structured health fields
 * (cleanup still pending); "reviewed"/"error" are terminal. The payload
 * carries only the record identity — clients re-read what they need
 * (or ignore it; unknown types are skipped).
 */
export function emitAiReviewed(kind: AiReviewedKind, id: string, status: AiReviewedStatus, attempts: number): void {
  if (clients.size === 0) return;
  const campId = currentCampId();
  const payload = JSON.stringify({ type: "ai-review-done", at: new Date().toISOString(), data: { kind, id, status, attempts } });
  for (const client of clients) if (client.campId === campId) safeSend(client, payload);
}

/**
 * An import's background health pass paused for a new sign-in (decision 50):
 * only the importer's sockets of that camp hear it — the import screen offers
 * "sign in again and resume". Ids only.
 */
export function emitImportNeedsSignIn(importId: string, personId: string, subject: "camper" | "staff"): void {
  if (clients.size === 0) return;
  const campId = currentCampId();
  const payload = JSON.stringify({ type: "import-needs-sign-in", at: new Date().toISOString(), data: { importId, subject } });
  for (const client of clients) if (client.campId === campId && client.personId === personId) safeSend(client, payload);
}

// ── staff access window: evict the ordinary team when it closes ─────────────

/**
 * Ordinary team members (see scope.staffHasAccess) may only use the app inside
 * `settings.staffAccessWindow`. When it closes — the timer fires or the admin
 * edits the window — their sessions are revoked and their sockets closed with
 * 4401, so the phone logs out and wipes its local copy at once.
 */
export async function evictStaffOutsideWindow(): Promise<void> {
  const [{ accessWindowClosed }, { findSession }] = await Promise.all([import("../middleware/auth"), import("./session")]);
  const byCamp = new Map<string, RealtimeClient[]>();
  for (const client of clients) byCamp.set(client.campId, [...(byCamp.get(client.campId) ?? []), client]);

  for (const [campId, campClients] of byCamp) {
    await withCamp(campId, async () => {
      for (const client of campClients) {
        const session = await findSession(client.sessionId);
        if (session && !(await accessWindowClosed(session))) continue;
        try {
          client.ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "O período de acesso terminou." }));
          client.ws.close(4401, "access window closed");
        } catch {
          /* already gone */
        }
        clients.delete(client);
        console.log(`🚪 access window closed → logged out a ${client.coreRole} session`);
      }
    });
  }
}

// ── check-in window: re-push at both edges ──────────────────────────────────

/**
 * A helper's scope flips when the window opens and when it closes, with no
 * write to trigger a publish. So we arm timers for both instants: when they
 * fire, the scoped collections are re-sent to every client — helpers receive
 * their extra data (or lose it), everyone else gets an identical payload.
 */
let edgeTimers: ReturnType<typeof setTimeout>[] = [];
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Re-arms every window edge from the current settings + programme: the
 * check-in window, the team access window and the PARENTS' window (check-in
 * start → end of the last event, see services/camp.ts). Call after any write
 * to the settings or to the programme's events, and at boot.
 */
export async function rearmWindows(): Promise<void> {
  const [{ getSettings }, { listEvents }, { parentWindowOf }] = await Promise.all([import("../models/settings"), import("../models/schedule"), import("./camp")]);
  const s = await getSettings();
  const pw = parentWindowOf(s, await listEvents());
  scheduleCheckinWindow(s.checkinWindow, s.staffAccessWindow, pw, s.parentAccessWindow, s.busReturnWindow, s.scoreHideWindow);
}

/** Re-arms every timer of THIS module for the active camp — used at boot and (phase 3) whenever the active camp changes. */
export async function rearmActiveCampTimers(): Promise<void> {
  const campId = activeCampId();
  await withCamp(campId, async () => {
    const { getSettings } = await import("../models/settings");
    await rearmWindows();
    scheduleCheckinReminder((await getSettings()).checkinReminder.at);
    scheduleBirthdayNotices();
  });
}

export function scheduleCheckinWindow(w: CheckinWindow, staffAccess?: CheckinWindow, parents?: CheckinWindow, parentAccess?: CheckinWindow, busReturn?: CheckinWindow, scoreHide?: CheckinWindow): void {
  for (const t of edgeTimers) clearTimeout(t);
  edgeTimers = [];
  const now = Date.now();
  for (const edge of [w.from, w.until, busReturn?.from ?? null, busReturn?.until ?? null, staffAccess?.from ?? null, staffAccess?.until ?? null, parents?.from ?? null, parents?.until ?? null, parentAccess?.from ?? null, parentAccess?.until ?? null, scoreHide?.from ?? null, scoreHide?.until ?? null]) {
    if (!edge) continue;
    const wait = edge.getTime() - now + 500; // a hair after, so the check sees the new state
    if (wait <= 0 || wait > MAX_TIMEOUT) continue;
    edgeTimers.push(
      setTimeout(() => {
        void withCamp(activeCampId(), async () => {
          console.log("⏰ check-in window edge reached → re-publishing scoped collections");
          publish("campers", "staff", "bedrooms", "roles", "events", "scores", "settings");
          await evictStaffOutsideWindow().catch((err) => console.error("realtime: evict failed", err));
          const m = await import("./notify");
          await Promise.all([m.syncWelcomes(), m.syncParentWelcomes()]); // a window may have just opened → welcome SMS
        });
      }, wait),
    );
  }
}

// ── check-in reminder: one timer for the instant the admin picked (re-armed on every settings write and at boot)
let reminderTimer: ReturnType<typeof setTimeout> | null = null;

/** Arms (or clears) the check-in reminder timer. `null` / a past instant / beyond setTimeout's limit → nothing armed (the hourly safety net and boot catch up). */
export function scheduleCheckinReminder(at: Date | null): void {
  if (reminderTimer) clearTimeout(reminderTimer);
  reminderTimer = null;
  if (!at) return;
  const wait = at.getTime() - Date.now() + 500;
  if (wait > MAX_TIMEOUT) return;
  reminderTimer = setTimeout(() => {
    reminderTimer = null;
    console.log("⏰ check-in reminder instant reached");
    void withCamp(activeCampId(), async () => (await import("./notify")).sendCheckinReminder());
  }, Math.max(0, wait));
}

// ── birthday SMS: one timer for the next 07:45 São Paulo (re-armed after each firing; the send itself checks whether today is a camp day)
let birthdayTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleBirthdayNotices(): void {
  if (birthdayTimer) clearTimeout(birthdayTimer);
  void import("./notify").then((m) => {
    const now = new Date();
    let due = m.birthdaySmsDue(todayInSaoPaulo(now));
    if (due.getTime() <= now.getTime()) due = m.birthdaySmsDue(todayInSaoPaulo(new Date(now.getTime() + 24 * 3600_000)));
    birthdayTimer = setTimeout(() => {
      birthdayTimer = null;
      console.log("⏰ 07:45 → birthday notices");
      void withCamp(activeCampId(), () => m.sendBirthdayNotices()).finally(scheduleBirthdayNotices);
    }, Math.min(due.getTime() - now.getTime() + 500, MAX_TIMEOUT));
  });
}

// ── safety net: an instant further than setTimeout's limit (~24 days) can't be armed, so re-check hourly
setInterval(
  () =>
    void withCamp(activeCampId(), async () => {
      const m = await import("./notify");
      await Promise.all([m.syncWelcomes(), m.syncParentWelcomes(), m.sendCheckinReminder(), m.sendBirthdayNotices()]);
    }),
  60 * 60_000,
);

// ── heartbeat (lets phones notice a dead connection and reconnect) ─────────

const PING_MS = 30_000;
setInterval(() => {
  const payload = JSON.stringify({ type: "ping", at: new Date().toISOString() });
  for (const client of clients) safeSend(client, payload);
}, PING_MS);
