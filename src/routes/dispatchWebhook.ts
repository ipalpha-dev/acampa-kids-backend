import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { config } from "../config";
import { claimDelivery } from "../models/dispatchDeliveries";
import { enqueueAppMessage, toAppMessage } from "../services/personImports";

/**
 * POST /api/dispatch/webhook — dispatch-api's fallback when Acampa's app
 * channel socket is not connected (CONTRACTS §21/§22). No session: the body
 * is authenticated by `X-IPAlpha-Signature: sha256=<hex HMAC-SHA256(secret,
 * raw body)>` with the app webhook secret (`IPALPHA_WEBHOOK_SECRET`),
 * compared in constant time. `X-IPAlpha-Delivery` makes it idempotent (ids
 * only, TTL collection). Answers fast (dispatch waits 5 s) and applies the
 * message in the background, in order with the socket's messages.
 */
const webhook = new Hono();

const MAX_BODY_BYTES = 1024 * 1024;
const DELIVERY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function signatureValid(secret: string, body: string, header: string | undefined): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec((header ?? "").trim());
  if (!secret || !m) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

webhook.post("/webhook", async (c) => {
  const secret = config.ipalpha.webhookSecret;
  if (!secret) return c.json({ error: { code: "WEBHOOK_DISABLED", message: "Webhook não configurado." } }, 503);
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Corpo grande demais." } }, 413);
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Corpo grande demais." } }, 413);
  if (!signatureValid(secret, raw, c.req.header("x-ipalpha-signature"))) {
    console.warn("[dispatch] webhook: bad signature — refused");
    return c.json({ error: { code: "SIGNATURE_INVALID", message: "Assinatura inválida." } }, 401);
  }
  const deliveryId = (c.req.header("x-ipalpha-delivery") ?? "").trim();
  if (!DELIVERY_RE.test(deliveryId)) return c.json({ error: { code: "DELIVERY_ID_INVALID", message: "X-IPAlpha-Delivery ausente ou inválido." } }, 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: { code: "BODY_INVALID", message: "JSON inválido." } }, 400);
  }
  const msg = toAppMessage(parsed);
  if (!msg) return c.json({ ok: true, ignored: true }, 202); // a message type this app does not handle — never retried
  let fresh: boolean;
  try {
    fresh = await claimDelivery(deliveryId);
  } catch {
    return c.json({ error: { code: "STARTING", message: "Tente novamente." } }, 503);
  }
  if (!fresh) return c.json({ ok: true, duplicate: true });
  // applying is idempotent and a failure is caught up by reconciliation (persons-api keeps the batches)
  void enqueueAppMessage(msg, config.ipalpha.projectId);
  return c.json({ ok: true }, 202);
});

export default webhook;
