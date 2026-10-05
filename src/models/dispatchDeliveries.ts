import { rawDb } from "../db";

/**
 * `dispatchDeliveries` — ONLY the ids of the webhook deliveries already
 * accepted (`X-IPAlpha-Delivery`), so a retried / duplicated POST is not
 * applied twice. No payload, no person data. TTL: 7 days (dispatch retries
 * for minutes; persons-api keeps results ≤ 30 days and Acampa's apply is
 * idempotent anyway). Global (not per camp).
 */
const COLLECTION = "dispatchDeliveries";
const TTL_SEC = 7 * 24 * 3600;

/** True when this id is new (and now recorded); false for a duplicate. */
export async function claimDelivery(id: string): Promise<boolean> {
  const db = await rawDb();
  try {
    await db.collection(COLLECTION).insertOne({ _id: id as never, at: new Date() });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

export async function ensureDispatchDeliveryIndexes(): Promise<void> {
  const db = await rawDb();
  await db.collection(COLLECTION).createIndex({ at: 1 }, { expireAfterSeconds: TTL_SEC });
}
