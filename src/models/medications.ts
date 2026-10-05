import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { MedicationDose } from "../types";
import { ensureIndex } from "../services/indexes";

/**
 * The medical team's checklist of doses actually GIVEN (Medicações tab).
 * One document per tick: kid + medicine + day + slot. A scheduled slot is
 * unique per (camper, medKey, day, slot) — ticking twice is the same tick,
 * unticking deletes it. "quando necessário" doses (slot "sos") may repeat.
 */
const COLLECTION = "medicationDoses";

/**
 * Stored beside every tick, never serialized: `true` for a dose with a fixed
 * "HH:MM", `false` for a "quando necessário" one. It exists only so the unique
 * index below can cover the scheduled doses and leave the repeatable ones out.
 */
const SCHEDULED_FIELD = "scheduled";

/**
 * Explicit index names (decision 91): the keys moved from `camperId` to `personId`, so the
 * names are new (`_v2`) and never collide with an index an older version left behind.
 */
const SCHEDULED_UNIQUE_INDEX = "dose_scheduled_unique_v2";
const PERSON_DAY_INDEX = "personId_day_v2";

/** Medicine name → a stable key, so a re-ordered / re-typed list still matches its ticks. */
export function medKeyOf(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function toDose(doc: Record<string, unknown> | null): MedicationDose | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    personId: (doc.personId as string) ?? "",
    medKey: (doc.medKey as string) ?? "",
    medName: (doc.medName as string) ?? "",
    dose: (doc.dose as string) ?? "",
    day: (doc.day as string) ?? "",
    slot: (doc.slot as string) ?? "",
    givenAt: doc.givenAt as Date,
    byPersonId: (doc.byPersonId as string) ?? "",
    note: (doc.note as string) ?? "",
  };
}

export type MedicationDoseData = Omit<MedicationDose, "_id" | "givenAt">;

/** Every tick, newest first. The dataset is tiny (a handful of kids × days). */
export async function listMedicationDoses(): Promise<MedicationDose[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find().sort({ day: -1, slot: 1, givenAt: -1 }).toArray();
  return docs.map((d) => toDose(d as Record<string, unknown>)!);
}

/**
 * Records a dose. A scheduled slot is one tick per kid, medicine and day:
 * ticking it again returns the tick already there (two phones at the same
 * counter must never create two records — the unique index below makes the
 * race impossible, this makes it invisible).
 */
export async function insertMedicationDose(data: MedicationDoseData, unique: boolean): Promise<MedicationDose> {
  const db = await getDb();
  const givenAt = new Date();
  const key = { personId: data.personId, medKey: data.medKey, day: data.day, slot: data.slot };
  if (unique) {
    const existing = await db.collection(COLLECTION).findOne(key);
    if (existing) return toDose(existing as Record<string, unknown>)!;
    try {
      const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, givenAt, [SCHEDULED_FIELD]: true });
      return { ...data, _id: insertedId.toString(), givenAt };
    } catch (err) {
      // another device ticked the very same dose in between: theirs is the one
      if ((err as { code?: number }).code !== 11000) throw err;
      return toDose((await db.collection(COLLECTION).findOne(key)) as Record<string, unknown> | null)!;
    }
  }
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, givenAt, [SCHEDULED_FIELD]: false });
  return { ...data, _id: insertedId.toString(), givenAt };
}

export async function findMedicationDoseById(id: string): Promise<MedicationDose | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toDose((await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) })) as Record<string, unknown> | null);
}

/** Unticks one dose (a mistake, or the kid did not take it after all). */
export async function deleteMedicationDose(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/* The end-of-camp wipe lives with the other blocks in models/cleanup.ts. */

export async function ensureMedicationIndexes(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    ensureIndex(db.collection(COLLECTION), { day: -1, slot: 1 }),
    ensureIndex(db.collection(COLLECTION), { personId: 1, day: -1 }, { name: PERSON_DAY_INDEX }),
    // a scheduled dose exists once per kid / medicine / day; "quando necessário" doses repeat, so they stay out of it
    ensureIndex(
      db.collection(COLLECTION),
      { personId: 1, medKey: 1, day: 1, slot: 1 },
      { name: SCHEDULED_UNIQUE_INDEX, unique: true, partialFilterExpression: { [SCHEDULED_FIELD]: true } },
    ),
  ]);
}
