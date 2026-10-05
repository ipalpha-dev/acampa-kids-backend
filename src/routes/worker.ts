import { Hono } from "hono";
import { config } from "../config";
import { emitAiReviewed, emitImportNeedsSignIn, publish, type AiReviewedKind, type AiReviewedStatus } from "../services/realtime";
import { findCamperImport } from "../models/camperImports";

/**
 * POST /api/worker/reviewed — the background import worker reports an AI-review
 * checkpoint: "structured" after the fast Jev pass (structured health fields
 * already written, cleanup pending) or "reviewed"/"error" terminal states.
 * `newOptions: true` also republishes the categories (the cleanup model created
 * options). The API process owns the WebSocket clients, so it re-reads and
 * publishes the changed collections here. The worker process cannot do that
 * directly because its in-memory realtime hub has no browser connections.
 *
 * Auth: shared secret, `Authorization: Bearer <WORKER_SECRET>`. Fail closed:
 * a missing or wrong secret (or none configured) is always 401.
 */
const worker = new Hono();

worker.post("/reviewed", async (c) => {
  const secret = config.worker.secret;
  const bearer = c.req.header("authorization") ?? "";
  if (!secret || bearer !== `Bearer ${secret}`) return c.json({ error: { code: "UNAUTHORIZED", message: "Segredo do worker inválido." } }, 401);
  const body = await c.req.json<{ kind?: unknown; id?: unknown; status?: unknown; attempts?: unknown; newOptions?: unknown }>().catch(() => null);
  const kind = body?.kind;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const status = body?.status;
  const attempts = typeof body?.attempts === "number" && Number.isFinite(body.attempts) ? Math.max(0, Math.floor(body.attempts)) : 0;
  const newOptions = body?.newOptions === true;
  if ((kind !== "camper" && kind !== "staff") || !id || (status !== "structured" && status !== "reviewed" && status !== "error")) {
    return c.json({ error: { code: "BAD_BODY", message: "Informe kind (camper|staff), id e status (structured|reviewed|error)." } }, 400);
  }
  publish(kind === "camper" ? "campers" : "staff");
  if (newOptions) publish("categories");
  emitAiReviewed(kind as AiReviewedKind, id, status as AiReviewedStatus, attempts);
  return c.json({ ok: true });
});

/**
 * POST /api/worker/import-paused {importId} — the worker paused an import's
 * health pass because the importer's IPAlpha token was refused / expired
 * (decision 50). The API process tells the importer's sockets
 * (`import-needs-sign-in`). Same shared-secret auth as /reviewed.
 */
worker.post("/import-paused", async (c) => {
  const secret = config.worker.secret;
  const bearer = c.req.header("authorization") ?? "";
  if (!secret || bearer !== `Bearer ${secret}`) return c.json({ error: { code: "UNAUTHORIZED", message: "Segredo do worker inválido." } }, 401);
  const body = await c.req.json<{ importId?: unknown }>().catch(() => null);
  const importId = typeof body?.importId === "string" ? body.importId.trim() : "";
  if (!importId) return c.json({ error: { code: "BAD_BODY", message: "Informe importId." } }, 400);
  const record = await findCamperImport(importId);
  if (!record) return c.json({ error: { code: "IMPORT_NOT_FOUND", message: "Importação não encontrada." } }, 404);
  if (record.status === "needsSignIn") emitImportNeedsSignIn(record._id, record.createdByPersonId, record.subject);
  return c.json({ ok: true, needsSignIn: record.status === "needsSignIn" });
});

export default worker;
