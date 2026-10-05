import { getDb } from "../db";
import { currentCampId } from "../services/campContext";
import type { BusHelperList, CheckinLocation, CheckinReminder, CheckinWindow, ParentContact, Settings } from "../types";

const COLLECTION = "settings";
/** the settings live in ONE document per camp — its `_id` IS the camp id (see services/campContext.ts) */
const DOC_ID = (): string => currentCampId();

/** Igreja Presbiteriana em Alphaville — where the team meets on departure day. */
export const DEFAULT_CHECKIN_LOCATION: CheckinLocation = {
  id: "church",
  name: "Igreja",
  lat: -23.48053637134259,
  lng: -46.83077891444747,
  radiusM: 300,
};

export const DEFAULT_SETTINGS: Settings = {
  checkinLocations: [DEFAULT_CHECKIN_LOCATION],
  // every kind starts OFF: the admin switches on what they want texted
  notifications: { bedroomChanges: false, roleChanges: false, checkinConfirmation: false, contentChanges: false, parentContentChanges: false, staffChanges: false, enrolments: false, occurrences: false, checkinReminder: false, parentEdits: false, busCheckin: false, parentWelcome: false, birthdays: false, photoPublishes: false },
  checkinWindow: { from: null, until: null },
  busReturnWindow: { from: null, until: null },
  busHelpers: { helpers: [] },
  parentContacts: [],
  staffAccessWindow: { from: null, until: null },
  parentAccessWindow: { from: null, until: null },
  checkinTestMode: false,
  kidsRoomsDraft: false,
  scoreDraft: false,
  scoreHideWindow: { from: null, until: null },
  wizardMode: false,
  galleryPublished: false,
  checkinReminder: { at: null, sentAt: null },
  updatedAt: null,
};

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Is the check-in window open at `now`? (needs both ends) */
export function checkinWindowOpen(w: CheckinWindow, now = new Date()): boolean {
  return !!w.from && !!w.until && w.from <= now && now < w.until;
}

/** Is the scoreboard hidden from the team right now? (needs both ends, like the check-in window) */
export function scoreHidden(w: CheckinWindow, now = new Date()): boolean {
  return checkinWindowOpen(w, now);
}

/** Is the ordinary team's access window open? Unlike the check-in window, an UNSET window means "always". */
export function staffAccessOpen(w: CheckinWindow, now = new Date()): boolean {
  if (!w.from && !w.until) return true;
  if (w.from && now < w.from) return false;
  if (w.until && now >= w.until) return false;
  return true;
}

/** `{ helpers: [{ personId, vehicleId }] }` — the vehicle each `checkin-onibus` person stands at */
function toBusHelperList(raw: unknown): BusHelperList {
  const h = (raw as Partial<Record<"helpers", unknown>> | undefined) ?? {};
  if (!Array.isArray(h.helpers)) return { helpers: [] };
  const helpers = h.helpers
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => !!x && typeof x.personId === "string" && typeof x.vehicleId === "string")
    .map((x) => ({ personId: x.personId as string, vehicleId: x.vehicleId as string }));
  return { helpers };
}

function toWindow(raw: unknown): CheckinWindow {
  const w = (raw as Partial<Record<keyof CheckinWindow, unknown>> | undefined) ?? {};
  return { from: asDate(w.from), until: asDate(w.until) };
}

function toReminder(raw: unknown): CheckinReminder {
  const r = (raw as Partial<Record<keyof CheckinReminder, unknown>> | undefined) ?? {};
  return { at: asDate(r.at), sentAt: asDate(r.sentAt) };
}

/** `checkinLocations: [{ id, name, lat, lng, radiusM }]` — none stored yet: the default "Igreja" spot. */
function toCheckinLocations(doc: Record<string, unknown>): CheckinLocation[] {
  const raw = doc.checkinLocations;
  if (Array.isArray(raw)) {
    const list = raw
      .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
      .filter((x): x is Record<string, unknown> => !!x && typeof x.id === "string" && typeof x.lat === "number" && typeof x.lng === "number")
      .map((x) => ({
        id: x.id as string,
        name: typeof x.name === "string" && x.name.trim() ? (x.name as string) : "Ponto de encontro",
        lat: x.lat as number,
        lng: x.lng as number,
        radiusM: typeof x.radiusM === "number" ? (x.radiusM as number) : DEFAULT_CHECKIN_LOCATION.radiusM,
      }));
    if (list.length > 0) return list;
  }
  return [{ ...DEFAULT_CHECKIN_LOCATION }];
}

function toParentContacts(raw: unknown): ParentContact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter(
      (x): x is Record<string, unknown> =>
        !!x && typeof x.id === "string" && typeof x.title === "string" && typeof x.personId === "string",
    )
    .map((x) => ({ id: x.id as string, title: x.title as string, personId: x.personId as string }));
}

function toSettings(doc: Record<string, unknown> | null): Settings {
  if (!doc) return DEFAULT_SETTINGS;
  const n = (doc.notifications as Partial<Settings["notifications"]> | undefined) ?? {};
  return {
    checkinWindow: toWindow(doc.checkinWindow),
    busReturnWindow: toWindow(doc.busReturnWindow),
    busHelpers: toBusHelperList(doc.busHelpers),
    parentContacts: toParentContacts(doc.parentContacts),
    staffAccessWindow: toWindow(doc.staffAccessWindow),
    parentAccessWindow: toWindow(doc.parentAccessWindow),
    checkinTestMode: doc.checkinTestMode === true,
    kidsRoomsDraft: doc.kidsRoomsDraft === true,
    scoreDraft: doc.scoreDraft === true,
    scoreHideWindow: toWindow(doc.scoreHideWindow),
    wizardMode: doc.wizardMode === true,
    galleryPublished: doc.galleryPublished === true,
    checkinReminder: toReminder(doc.checkinReminder),
    notifications: {
      bedroomChanges: typeof n.bedroomChanges === "boolean" ? n.bedroomChanges : DEFAULT_SETTINGS.notifications.bedroomChanges,
      roleChanges: typeof n.roleChanges === "boolean" ? n.roleChanges : DEFAULT_SETTINGS.notifications.roleChanges,
      checkinConfirmation: typeof n.checkinConfirmation === "boolean" ? n.checkinConfirmation : DEFAULT_SETTINGS.notifications.checkinConfirmation,
      contentChanges: typeof n.contentChanges === "boolean" ? n.contentChanges : DEFAULT_SETTINGS.notifications.contentChanges,
      parentContentChanges: typeof n.parentContentChanges === "boolean" ? n.parentContentChanges : DEFAULT_SETTINGS.notifications.parentContentChanges,
      staffChanges: typeof n.staffChanges === "boolean" ? n.staffChanges : DEFAULT_SETTINGS.notifications.staffChanges,
      enrolments: typeof n.enrolments === "boolean" ? n.enrolments : DEFAULT_SETTINGS.notifications.enrolments,
      occurrences: typeof n.occurrences === "boolean" ? n.occurrences : DEFAULT_SETTINGS.notifications.occurrences,
      checkinReminder: typeof n.checkinReminder === "boolean" ? n.checkinReminder : DEFAULT_SETTINGS.notifications.checkinReminder,
      parentEdits: typeof n.parentEdits === "boolean" ? n.parentEdits : DEFAULT_SETTINGS.notifications.parentEdits,
      busCheckin: typeof n.busCheckin === "boolean" ? n.busCheckin : DEFAULT_SETTINGS.notifications.busCheckin,
      parentWelcome: typeof n.parentWelcome === "boolean" ? n.parentWelcome : DEFAULT_SETTINGS.notifications.parentWelcome,
      birthdays: typeof n.birthdays === "boolean" ? n.birthdays : DEFAULT_SETTINGS.notifications.birthdays,
      photoPublishes: typeof n.photoPublishes === "boolean" ? n.photoPublishes : DEFAULT_SETTINGS.notifications.photoPublishes,
    },
    checkinLocations: toCheckinLocations(doc),
    updatedAt: (doc.updatedAt as Date) ?? null,
  };
}

/** Always returns something: the defaults until an admin saves for the first time. */
export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  return toSettings((await db.collection(COLLECTION).findOne({ _id: DOC_ID() as never })) as Record<string, unknown> | null);
}

export async function updateSettings(patch: Partial<Omit<Settings, "updatedAt">>): Promise<Settings> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: DOC_ID() as never }, { $set: { ...patch, updatedAt: new Date() } }, { upsert: true, returnDocument: "after" });
  return toSettings(res as Record<string, unknown> | null);
}

/**
 * Marks the check-in reminder scheduled for `at` as sent — atomically, only
 * if that exact instant is still scheduled and was NOT sent yet. Returns true
 * when this call won (so the caller may text the team).
 */
export async function claimCheckinReminder(at: Date): Promise<boolean> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .updateOne({ _id: DOC_ID() as never, "checkinReminder.at": at, "checkinReminder.sentAt": null }, { $set: { "checkinReminder.sentAt": new Date() } });
  return res.modifiedCount === 1;
}
