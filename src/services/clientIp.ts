import { isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { config } from "../config";

/**
 * The caller's IP, for auth-api's per-IP relay limit and our own /start limit.
 *
 * Assumption: the API runs behind `TRUST_PROXY_HOPS` proxies (Traefik ingress
 * = 1) that each APPEND the address they saw to X-Forwarded-For. So the client
 * is the entry `hops` positions from the right; everything to its left was
 * sent by the client and is never trusted. Without the header (or hops = 0)
 * the socket address is used. Only a real IP (`net.isIP`) is ever returned.
 */
export function clientIp(c: Context, hops = config.trustProxyHops): string | undefined {
  if (hops > 0) {
    const entries = (c.req.header("x-forwarded-for") ?? "").split(",").map((e) => e.trim()).filter(Boolean);
    if (entries.length > 0) {
      // fewer entries than hops: the leftmost one was still appended by a trusted proxy
      const candidate = entries[Math.max(0, entries.length - hops)];
      if (isIP(candidate)) return candidate;
    }
  }
  try {
    const socket = getConnInfo(c).remote.address;
    return socket && isIP(socket) ? socket : undefined;
  } catch {
    return undefined;
  }
}
