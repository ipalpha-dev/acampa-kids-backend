import { getDb } from "../db";

const COLLECTION = "sms_usage";

/** what one SMS costs, in reais — ≈ 9,5 centavos per SMS sent (the "Sobre" page estimate) */
export const SMS_COST_BRL = 0.095;

/** One message request to notifications-api: template + how many went out. Never a phone, e-mail or person id. */
export interface SmsUsageEntry {
  at: Date;
  templateSlug: string;
  channel: "sms" | "email";
  sent: number;
}

export interface SmsUsageTotal {
  sent: number;
  /** SMS sent × SMS_COST_BRL */
  costBrl: number;
  lastAt: string | null;
}

export async function recordSms(entry: SmsUsageEntry): Promise<void> {
  if (entry.sent <= 0) return;
  const db = await getDb();
  await db.collection(COLLECTION).insertOne(entry).catch((e) => console.error("sms usage: insert failed", e));
}

/** Totals for the settings "Sobre" page: how many SMS went out and what they cost (e-mails are not counted). */
export async function smsUsageTotal(): Promise<SmsUsageTotal> {
  const db = await getDb();
  const rows = (await db
    .collection(COLLECTION)
    .aggregate([{ $match: { channel: { $ne: "email" } } }, { $group: { _id: null, sent: { $sum: { $ifNull: ["$sent", 1] } }, lastAt: { $max: "$at" } } }])
    .toArray()) as { sent: number; lastAt: Date | null }[];
  const r = rows[0];
  return { sent: r?.sent ?? 0, costBrl: (r?.sent ?? 0) * SMS_COST_BRL, lastAt: r?.lastAt ? r.lastAt.toISOString() : null };
}

export async function ensureSmsUsageIndex(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ at: -1 });
}
