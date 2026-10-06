import { rawDb } from "../db";
import { refreshActiveCamp } from "./campContext";

const CAMPS_COLLECTION = "camps";

/**
 * Boot: exactly one ACTIVE camp exists after this (a fresh database gets
 * "Acampa Kids <this year>"). No data migration — Acampa starts clean on the
 * IPAlpha model (decision 33).
 */
export async function ensureFirstCamp(): Promise<void> {
  const db = await rawDb();
  const count = await db.collection(CAMPS_COLLECTION).countDocuments({});
  if (count === 0) {
    const year = new Date().getFullYear();
    await db.collection(CAMPS_COLLECTION).insertOne({ label: `Acampa Kids ${year}`, year, active: true, archivedAt: null, createdAt: new Date(), createdByPersonId: null, editionId: null });
    console.log(`🏕️  camps: created the first camp — "Acampa Kids ${year}"`);
  }
  await refreshActiveCamp();
}
