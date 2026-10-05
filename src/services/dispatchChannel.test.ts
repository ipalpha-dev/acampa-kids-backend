import { describe, expect, test } from "bun:test";
import { DispatchChannel, type ChannelSocket } from "./dispatchChannel";

/** A socket.io client stand-in: tests fire server events by hand. */
class FakeSocket implements ChannelSocket {
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  emitted: { event: string; args: unknown[] }[] = [];
  disconnected = false;
  ack: (event: string, body: unknown) => unknown = () => ({ ok: true, key: "person-imports", data: null });
  constructor(readonly url: string, readonly token: string) {}
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
    return this;
  }
  timeout() {
    return { emitWithAck: async (event: string, body: unknown) => { this.emitted.push({ event, args: [body] }); return this.ack(event, body); } };
  }
  disconnect() {
    this.disconnected = true;
    return this;
  }
  removeAllListeners() {
    this.listeners.clear();
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const messages: unknown[] = [];
  const subscribed: boolean[] = [];
  const tokens: boolean[] = [];
  const channel = new DispatchChannel("https://dispatch.test.invalid", {
    connect: (url, token) => {
      const s = new FakeSocket(url, token);
      sockets.push(s);
      return s;
    },
    token: async (fresh) => {
      tokens.push(fresh);
      return { token: `t${tokens.length}`, expiresAt: Date.now() + 3600_000 };
    },
    onMessage: (raw) => messages.push(raw),
    onSubscribed: (reconnect) => subscribed.push(reconnect),
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t as never;
    },
    clearTimer: (t) => {
      (t as unknown as { cleared: boolean }).cleared = true;
    },
    log: () => {},
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** runs the newest pending retry timer */
  const runRetry = async () => {
    const t = [...timers].reverse().find((x) => !x.cleared && x.ms < 3600_000 - 60_000 - 1);
    if (!t) throw new Error("no retry pending");
    t.cleared = true;
    t.fn();
    await tick();
  };
  return { channel, sockets, timers, messages, subscribed, tokens, tick, runRetry };
}

describe("dispatch app channel (§21): one socket, backoff, resubscribe", () => {
  test("connects with the app token, subscribes person-imports, forwards messages", async () => {
    const h = harness();
    h.channel.start();
    await h.tick();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].token).toBe("t1");
    h.sockets[0].fire("connect");
    await h.tick();
    expect(h.sockets[0].emitted[0]).toEqual({ event: "subscribe", args: [{ topic: "person-imports" }] });
    expect(h.channel.state).toBe("connected");
    expect(h.subscribed).toEqual([false]);
    h.sockets[0].fire("person-import.batch", { id: "m1" });
    h.sockets[0].fire("person-import.progress", { id: "m2" });
    expect(h.messages).toEqual([{ id: "m1" }, { id: "m2" }]);
    // start() again never opens a second socket
    h.channel.start();
    expect(h.sockets).toHaveLength(1);
  });

  test("a drop reconnects with backoff, a fresh socket resubscribes and asks for reconciliation", async () => {
    const h = harness();
    h.channel.start();
    await h.tick();
    h.sockets[0].fire("connect");
    await h.tick();
    h.sockets[0].fire("disconnect", "transport close");
    expect(h.channel.state).toBe("disconnected");
    expect(h.sockets[0].disconnected).toBe(true);
    await h.runRetry();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].fire("connect");
    await h.tick();
    expect(h.channel.state).toBe("connected");
    expect(h.subscribed).toEqual([false, true]);
    // events of the old socket are ignored
    h.sockets[0].fire("person-import.batch", { id: "late" });
    expect(h.messages).toEqual([]);
  });

  test("backoff grows and is capped", () => {
    const h = harness();
    const waits = [0, 1, 2, 3, 8, 20].map((n) => h.channel.backoffMs(n));
    expect(waits).toEqual([500, 1000, 2000, 4000, 30000, 30000]);
  });

  test("a refused subscribe or connect error retries with a fresh token", async () => {
    const h = harness();
    h.channel.start();
    await h.tick();
    h.sockets[0].ack = () => ({ ok: false, reason: "rateLimited" });
    h.sockets[0].fire("connect");
    await h.tick();
    expect(h.channel.state).toBe("disconnected");
    await h.runRetry();
    expect(h.tokens).toEqual([false, true]);
    h.sockets[1].fire("connect_error", new Error("xhr poll error"));
    await h.runRetry();
    expect(h.sockets).toHaveLength(3);
  });

  test("replaced by a newer connection: stops for good (never fights it)", async () => {
    const h = harness();
    h.channel.start();
    await h.tick();
    h.sockets[0].fire("connect");
    await h.tick();
    h.sockets[0].fire("replaced", { reason: "replaced" });
    expect(h.channel.state).toBe("replaced");
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0);
    h.channel.start();
    await h.tick();
    expect(h.sockets).toHaveLength(1);
  });

  test("auth-error 403 (scope / app mismatch) waits 5 minutes before trying again", async () => {
    const h = harness();
    h.channel.start();
    await h.tick();
    h.sockets[0].fire("auth-error", { status: 403, reason: "scopeRequired" });
    expect(h.channel.state).toBe("refused");
    expect(h.timers.at(-1)!.ms).toBe(5 * 60_000);
  });
});
