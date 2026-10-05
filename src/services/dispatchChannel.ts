import { io } from "socket.io-client";
import { config } from "../config";
import { coreClient, ipalphaEnabled } from "./ipalpha";
import { catchUpUnfinished, enqueueAppMessage, toAppMessage } from "./personImports";

/**
 * The ONE persistent dispatch app-channel socket of this backend (CONTRACTS
 * §21, decisions 62/65): handshake with the app-bound system token (scope
 * `dispatch:app-channel`), every subscription multiplexed on it (today:
 * `person-imports` — every import of Acampa's app), reconnect with
 * exponential backoff + jitter (a fresh token each time), resubscribe on
 * every connect, and catch up every unfinished import (`importJobs`,
 * decision 77) from persons-api after each connect (dispatch is stateless;
 * the owner keeps the results — decision 64). Started after boot, never awaited by it: a dispatch outage only
 * shows as `info.dispatch` on /ready. Messages that arrive while the socket
 * is down come through the signed webhook (routes/dispatchWebhook.ts).
 *
 * `replaced` (another instance of the app connected) stops this socket for
 * good in this process — never fight the newer connection (dispatch keeps
 * exactly one per app); the webhook keeps delivering.
 */

export const APP_CHANNEL_NAMESPACE = "/apps";
export const DISPATCH_SOCKET_PATH = "/api/dispatch/socket.io";
export const APP_TOPICS = ["person-imports"] as const;
const MESSAGE_EVENTS = ["person-import.progress", "person-import.batch"] as const;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** dispatch refused us on purpose (scope / app mismatch / rate limit): wait longer before trying again */
const REFUSED_BACKOFF_MS = 5 * 60_000;
const ACK_TIMEOUT_MS = 10_000;
/** renew the handshake token this long before it expires (`auth` event, subscriptions stay) */
const TOKEN_RENEW_SKEW_MS = 60_000;

export type ChannelState = "off" | "connecting" | "connected" | "disconnected" | "replaced" | "refused";

/** The slice of a socket.io client socket this module uses (tests inject a fake). */
export interface ChannelSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  timeout(ms: number): { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
  disconnect(): unknown;
  removeAllListeners(): unknown;
}

export interface ChannelDeps {
  /** opens the socket (default: socket.io-client, namespace `/apps`, websocket only, no built-in reconnection) */
  connect?: (url: string, token: string) => ChannelSocket;
  /** the handshake token (default: the core client's app-channel system token) */
  token?: (fresh: boolean) => Promise<{ token: string; expiresAt: number }>;
  /** one message (default: the import queue) */
  onMessage?: (raw: unknown) => void;
  /** after (re)subscribing (default: catch up every unfinished import from persons-api — decision 77) */
  onSubscribed?: (reconnect: boolean) => void;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  log?: (line: string) => void;
}

export class DispatchChannel {
  state: ChannelState = "off";
  private socket: ChannelSocket | null = null;
  private attempts = 0;
  private connectedOnce = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: Required<ChannelDeps>;

  constructor(private readonly url: string, deps: ChannelDeps = {}) {
    this.deps = {
      connect:
        deps.connect ??
        ((base, token) =>
          io(`${base}${APP_CHANNEL_NAMESPACE}`, {
            path: DISPATCH_SOCKET_PATH,
            transports: ["websocket"],
            reconnection: false,
            auth: { token },
          }) as unknown as ChannelSocket),
      token: deps.token ?? ((fresh) => coreClient().appChannelToken(fresh)),
      onMessage: deps.onMessage ?? ((raw) => {
        const msg = toAppMessage(raw);
        if (msg) void enqueueAppMessage(msg, config.ipalpha.projectId);
      }),
      // every connect: messages sent while the socket was down (and before this process started) may be missing
      onSubscribed: deps.onSubscribed ?? (() => {
        void catchUpUnfinished()
          .then((n) => n && this.deps.log(`caught up ${n} import(s)`))
          .catch(() => this.deps.log("import catch-up failed — next connect / the importer's next read tries again"));
      }),
      random: deps.random ?? Math.random,
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((t) => clearTimeout(t)),
      log: deps.log ?? ((line) => console.log(`[dispatch] ${line}`)),
    };
  }

  start(): void {
    if (this.socket || this.retryTimer || this.stopped) return;
    void this.open(false);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket();
    if (this.state !== "replaced") this.state = "off";
  }

  private clearTimers(): void {
    if (this.retryTimer) this.deps.clearTimer(this.retryTimer);
    if (this.renewTimer) this.deps.clearTimer(this.renewTimer);
    this.retryTimer = null;
    this.renewTimer = null;
  }

  private closeSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.removeAllListeners();
    s.disconnect();
  }

  /** exponential backoff with full jitter, capped */
  backoffMs(attempt: number): number {
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 10));
    return Math.max(BACKOFF_BASE_MS / 2, Math.floor(this.deps.random() * cap));
  }

  private retry(delay?: number, freshToken = false): void {
    if (this.stopped) return;
    this.closeSocket();
    this.clearTimers();
    if (this.state !== "refused") this.state = "disconnected";
    const wait = delay ?? this.backoffMs(this.attempts++);
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      void this.open(freshToken);
    }, wait);
  }

  private async open(freshToken: boolean): Promise<void> {
    if (this.stopped) return;
    this.state = "connecting";
    let token: { token: string; expiresAt: number };
    try {
      token = await this.deps.token(freshToken);
    } catch {
      this.deps.log("no app-channel token (auth-api unreachable or scope missing) — retrying");
      return this.retry();
    }
    if (this.stopped) return;
    const socket = this.deps.connect(this.url, token.token);
    this.socket = socket;
    const mine = () => this.socket === socket;
    socket.on("connect", () => {
      if (!mine()) return;
      void this.subscribe(socket, token.expiresAt);
    });
    socket.on("connect_error", (err: unknown) => {
      if (!mine()) return;
      this.deps.log(`connect failed (${err instanceof Error ? err.message : "error"})`);
      this.retry(undefined, true);
    });
    socket.on("disconnect", (reason: unknown) => {
      if (!mine() || this.state === "replaced") return;
      this.deps.log(`disconnected (${typeof reason === "string" ? reason : "unknown"}) — reconnecting`);
      this.retry();
    });
    socket.on("replaced", () => {
      if (!mine()) return;
      this.deps.log("replaced by a newer connection of this app — this socket stops (webhook keeps delivering)");
      this.state = "replaced";
      this.stopped = true;
      this.clearTimers();
      this.closeSocket();
    });
    socket.on("auth-expired", () => {
      if (!mine()) return;
      this.deps.log("token expired / revoked — reconnecting with a fresh one");
      this.retry(this.backoffMs(0), true);
    });
    socket.on("auth-error", (body: unknown) => {
      if (!mine()) return;
      const status = typeof (body as { status?: unknown })?.status === "number" ? (body as { status: number }).status : 401;
      const reason = typeof (body as { reason?: unknown })?.reason === "string" ? (body as { reason: string }).reason : "unknown";
      this.deps.log(`refused (${status} ${reason})`);
      if (status === 403 || status === 429) {
        this.state = "refused";
        this.retry(REFUSED_BACKOFF_MS, true);
      } else this.retry(undefined, true);
    });
    for (const event of MESSAGE_EVENTS) socket.on(event, (raw: unknown) => mine() && this.deps.onMessage(raw));
  }

  private async subscribe(socket: ChannelSocket, tokenExpiresAt: number): Promise<void> {
    try {
      for (const topic of APP_TOPICS) {
        const ack = (await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("subscribe", { topic })) as { ok?: boolean; reason?: string } | undefined;
        if (!ack?.ok) throw new Error(`subscribe ${topic}: ${ack?.reason ?? "refused"}`);
      }
    } catch (err) {
      if (this.socket !== socket) return;
      this.deps.log(`${err instanceof Error ? err.message : "subscribe failed"} — reconnecting`);
      return this.retry(undefined, true);
    }
    if (this.socket !== socket) return;
    const reconnect = this.connectedOnce;
    this.connectedOnce = true;
    this.attempts = 0;
    this.state = "connected";
    this.deps.log(reconnect ? "reconnected and resubscribed" : "connected");
    this.scheduleRenew(socket, tokenExpiresAt);
    this.deps.onSubscribed(reconnect);
  }

  /** system tokens live ≤ 1 h: renew on the same socket (`auth`), subscriptions stay */
  private scheduleRenew(socket: ChannelSocket, expiresAt: number): void {
    if (this.renewTimer) this.deps.clearTimer(this.renewTimer);
    const wait = Math.max(5_000, expiresAt - Date.now() - TOKEN_RENEW_SKEW_MS);
    this.renewTimer = this.deps.setTimer(() => {
      this.renewTimer = null;
      void (async () => {
        if (this.socket !== socket) return;
        try {
          const next = await this.deps.token(true);
          const ack = (await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("auth", { token: next.token })) as { ok?: boolean } | undefined;
          if (!ack?.ok) throw new Error("refused");
          this.scheduleRenew(socket, next.expiresAt);
        } catch {
          if (this.socket === socket) this.retry(undefined, true);
        }
      })();
    }, wait);
  }
}

let channel: DispatchChannel | null = null;

/** The process-wide channel (null until started / when not configured). */
export function dispatchChannel(): DispatchChannel | null {
  return channel;
}

export function dispatchState(): ChannelState {
  return channel?.state ?? "off";
}

/** Starts the ONE app channel when IPAlpha and `IPALPHA_DISPATCH_URL` are configured. Never throws, never awaited by boot. */
export function startDispatchChannel(): void {
  if (channel) return;
  if (!ipalphaEnabled() || !config.ipalpha.dispatchUrl) {
    console.log("[dispatch] app channel off (IPALPHA_DISPATCH_URL not set) — imports arrive by webhook / reconciliation");
    return;
  }
  channel = new DispatchChannel(config.ipalpha.dispatchUrl);
  channel.start();
}

/** tests only */
export function resetDispatchChannel(): void {
  channel?.stop();
  channel = null;
}
