import { appLink, localeForPhone, parentFieldLabel, sms, smsPrefix, type Locale } from "../i18n";
import { findBedroomById, listBedrooms } from "../models/bedrooms";
import { claimBirthdayNotice, listCampers, listCampersOfGuardian } from "../models/campers";
import { listCategories } from "../models/categories";
import { findTransportById } from "../models/transports";
import { transportLabel as transportLabelOf } from "../routes/transports";
import { listRoles } from "../models/schedule";
import { claimCheckinReminder, getSettings, staffAccessOpen } from "../models/settings";
import { claimStaffPhotosNotice, claimStaffWelcome, findStaffById, findStaffByPhone, listStaff } from "../models/staff";
import { findTeamById, listTeams } from "../models/teams";
import { claimParentPhotosNotice, claimParentWelcome, listAdmins, listParents } from "../models/users";
import { PREP_AUDIENCES } from "../types";
import type { Bedroom, CampEvent, Camper, CamperChangeLog, DocAudience, InstructionDoc, Occurrence, PrepAudience, PrepSection, RoomRole, ScheduleRole, Settings, Staff, Team } from "../types";
import { formatBrazilPhone, saoPauloWallClock, saoPauloWallClockToIso, todayInSaoPaulo } from "../utils";
import { birthdayDuringCamp, campPeriod } from "./camp";
import { comteleEnabled, comteleSendSms, resolveSmsTarget, type SmsAudience } from "./comtele";
import {
  accessWindowLabel,
  birthdayEmail,
  busCheckinEmail,
  checkinEmail,
  instructionEmail,
  occurrenceEmail,
  parentEditEmail,
  parentPrepEmail,
  parentWelcomeEmail,
  prepEmail,
  roleDocEmail,
  roomsAppliedEmail,
  staffWelcomeEmail,
} from "./emails";
import { sendMail } from "./mail";
import { staffHasAccess } from "./scope";
import { assignmentDetail, autoAudienceLabel, autoRoleCovers, autoRoleFor, isAutomatic, teamMap } from "./schedule";

/**
 * Texts (SMS via Comtele) the team members concerned by a change, saying
 * WHAT changed in one short line each, so most of the time the person does
 * not even need to open the app:
 *
 *   - a kid was put under / taken from someone's care (caretakers only —
 *     helpers are never texted about kids)
 *   - someone's role in an event changed (assigned, reassigned, removed,
 *     the event moved or was deleted)
 *   - a general Instruções / Preparação document changed, or the
 *     instructions / preparation text of one of the person's roles
 *   - (PARENTS) a Preparação section posted to them changed — only inside
 *     `settings.parentAccessWindow`
 *   - the person's own room / room role (responsável ↔ auxiliar) / team / vehicle changed
 *   - the person's church check-in was recorded (confirmation, sent at once)
 *   - an occurrence was registered (every ADMIN, sent at once)
 *   - the check-in reminder (WHOLE team, at the instant the admin picked)
 *
 * Each kind can be switched off by the admin (Settings → Notificações).
 * ORDINARY team members are only texted inside `settings.staffAccessWindow`
 * (Settings → Geral) — the same period in which they may use the app; people
 * on an admin list (organizers, helpers, medical, vest helpers, contacts) are always texted.
 * Checked at SEND time, so a queued text is dropped if the window closed.
 *
 * Sends are COALESCED: every change for the same person within a short window
 * becomes one SMS, so bulk edits on the admin screen don't flood anyone's
 * phone. The text is packed into ONE SMS (160 chars): as many change lines as
 * fit, then "+N mudanças" and the app link. Delivery is best-effort and never
 * blocks the write.
 */

export type NotifyKind = "bedroom" | "role" | "instructions" | "preparation" | "myRoom" | "myRoomRole" | "myTeam" | "myBus" | "photos";

interface Item {
  kind: NotifyKind;
  /** one short sentence, no trailing period, e.g. "Maria entrou no seu quarto 103" */
  text: string;
}

/** whoever gets the coalesced text: a team member (gated by the team window) or a parent (gated by the parents' window) */
interface Pending {
  to: { name: string; phone: string | null };
  gate: { kind: "staff"; staffId: string } | { kind: "parent" };
  items: Item[];
  locale: Locale;
}

/** one SMS segment — longer texts are split and billed as several */
export const SMS_MAX = 160;

/** how long to wait for more changes to the same person before texting */
const COALESCE_MS = Number(process.env.NOTIFY_COALESCE_SECONDS ?? 20) * 1000;

const queue = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** may this queued person still be texted right now? (checked when queued AND when sent) */
function gateOpen(gate: Pending["gate"], settings: Settings): boolean {
  return gate.kind === "staff" ? staffHasAccess(gate.staffId, settings) : staffAccessOpen(settings.parentAccessWindow);
}

function push(key: string, to: Pending["to"], gate: Pending["gate"], kind: NotifyKind, text: string, settings: Settings, locale: Locale): void {
  if (!to.phone) return;
  if (!gateOpen(gate, settings)) return;
  const p = queue.get(key) ?? { to, gate, items: [], locale };
  if (!p.items.some((i) => i.text === text)) p.items.push({ kind, text }); // same change twice (double save) → once
  queue.set(key, p);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, COALESCE_MS);
  }
}

async function enqueue(staff: Staff, kind: NotifyKind, text: string, settings: Settings): Promise<void> {
  const locale = await localeForPhone(staff.phone);
  push(`staff:${staff._id}`, staff, { kind: "staff", staffId: staff._id }, kind, text, settings, locale);
}

/** a PARENT (users doc with the parent role) — only inside the parents' access window */
async function enqueueParent(parent: { _id: string; name: string; phone: string | null; locale?: Locale }, kind: NotifyKind, text: string, settings: Settings): Promise<void> {
  const locale = parent.locale ?? (await localeForPhone(parent.phone));
  push(`parent:${parent._id}`, parent, { kind: "parent" }, kind, text, settings, locale);
}

function first(name: string): string {
  return name.split(" ")[0] || name;
}

// ── text helpers ─────────────────────────────────────────────────────────────

const DATE_LOCALE: Record<Locale, string> = { pt: "pt-BR", en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE" };

/** "2026-09-12" → "sáb 12/09" — weekday voice follows the recipient's language */
export function shortDate(iso: string, locale: Locale = "pt"): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const wd = new Intl.DateTimeFormat(DATE_LOCALE[locale], { weekday: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)))
    .replace(".", "");
  return `${wd} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

/** "sáb 12/09 14:00 Piscina" */
function eventLabel(e: CampEvent, locale: Locale = "pt"): string {
  return `${shortDate(e.date, locale)} ${e.startTime} ${e.title}`;
}

/** "Monitor (Base 3)" */
function dutyLabel(roleId: string, detail: string, roleById: Map<string, ScheduleRole>, locale: Locale = "pt"): string {
  const name = roleById.get(roleId)?.name ?? sms(locale, "otherRole");
  return detail ? `${name} (${detail})` : name;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

async function bedroomName(id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await findBedroomById(id))?.name ?? null;
}

async function transportLabel(id: string | null): Promise<string | null> {
  if (!id) return null;
  const t = await findTransportById(id);
  return t ? transportLabelOf(t) : null;
}

function staffEmailOf(staff: Pick<Staff, "email">): string {
  return staff.email?.trim() || "";
}

async function parentEmailOf(phone: string | null | undefined, fallback = ""): Promise<string> {
  if (fallback.trim()) return fallback.trim().toLowerCase();
  if (!phone) return "";
  const kids = await listCampersOfGuardian(phone);
  return kids.find((k) => k.guardianEmail)?.guardianEmail?.trim().toLowerCase() || "";
}

async function adminEmailOf(admin: { phone: string | null }): Promise<string> {
  if (!admin.phone) return "";
  const staff = await findStaffByPhone(admin.phone);
  return staff?.email?.trim() || "";
}

async function optionLabelOf(): Promise<(id: string) => string> {
  const cats = await listCategories();
  const map = new Map<string, string>();
  for (const c of cats) for (const o of c.options) map.set(o.id, o.label);
  return (id) => map.get(id) || id;
}

async function parentContactsForEmail(): Promise<{ title: string; name: string; phone: string | null }[]> {
  const settings = await getSettings();
  if (!settings.parentContacts.length) return [];
  const staff = await listStaff({ active: true });
  const byId = new Map(staff.map((s) => [s._id, s]));
  return settings.parentContacts.flatMap((c) => {
    const s = byId.get(c.staffId);
    return s ? [{ title: c.title, name: s.name, phone: s.phone }] : [];
  });
}

async function mail(to: string, mail: { subject: string; html: string; text: string } | null, label: string): Promise<void> {
  if (!to || !mail) return;
  const res = await sendMail(to, mail.subject, mail.html, mail.text);
  if (res.ok) console.log(`✉️  [NOTIFY · MAIL${res.mocked ? " · DEV MOCK" : ""}] ${to} (${label})`);
}

/**
 * The SMS text — one line, packed into a single segment: as many change
 * lines as fit, then "+N mudanças" for the rest, and the app link.
 */
export function composeSms(p: Pick<Pending, "to" | "items" | "locale">): string {
  const locale = p.locale ?? "pt";
  const head = `${smsPrefix()}: ${first(p.to.name)}, `;
  const texts = p.items.map((i) => i.text);
  const link = appLink();

  const render = (shown: string[], rest: number): string => {
    const tail =
      rest > 0
        ? sms(locale, rest > 1 ? "coalesceTailMany" : "coalesceTail", { rest, link })
        : sms(locale, "coalesceLink", { link });
    return `${head}${shown.join("; ")}${tail}`;
  };

  for (let n = texts.length; n >= 1; n--) {
    const msg = render(texts.slice(0, n), texts.length - n);
    if (msg.length <= SMS_MAX) return msg;
  }
  // even the first line alone overflows: clip it
  const fixed = render([""], texts.length - 1).length;
  return render([clip(texts[0], SMS_MAX - fixed)], texts.length - 1);
}

/**
 * Actually texts one person (or prints it, without a Comtele key). While the
 * SMS redirect (Settings → Testes) is on, the text goes to the admin's test
 * phone for `audience` instead — or nowhere, when that phone is unset.
 */
async function deliver(to: { name: string; phone: string | null }, text: string, label: string, audience: SmsAudience = "staff"): Promise<void> {
  const target = await resolveSmsTarget(to.phone!, audience);
  if (!target) {
    console.log(`📲 [NOTIFY · REDIRECT] ${to.name} (${label}) dropped — no test phone for ${audience}`);
    return;
  }
  const tag = target.redirected ? ` → redirect ${formatBrazilPhone(target.phone)}` : "";
  if (!comteleEnabled()) {
    console.log(`\n📲 [NOTIFY · DEV MOCK] ${to.name} — ${formatBrazilPhone(to.phone!)}${tag}: ${text}\n`);
    return;
  }
  const res = await comteleSendSms(target.phone, text);
  if (res.ok) console.log(`📲 [NOTIFY · SMS] ${to.name} (${label})${tag}`);
  else console.error(`[comtele] notify to ${to.name} failed:`, res.message);
}

async function flush(): Promise<void> {
  const batch = [...queue.values()];
  queue.clear();
  if (batch.length === 0) return;
  const settings = await getSettings().catch(() => null);
  for (const p of batch) {
    if (settings && !gateOpen(p.gate, settings)) continue; // window closed while coalescing
    await deliver(p.to, composeSms(p), [...new Set(p.items.map((i) => i.kind))].join("+"), p.gate.kind);
  }
}

/** Sends whatever is queued right now (tests / graceful shutdown). */
export async function flushNotifications(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

// ── check-in confirmation ────────────────────────────────────────────────────────────

/**
 * The confirmation text — a receipt plus what the person needs next: their
 * room (and how many kids are in it) and their vehicle.
 */
export function composeCheckinSms(staff: Staff, ctx: { room?: string | null; kids?: number; bus?: string | null } = {}, locale: Locale = "pt"): string {
  const parts: string[] = [];
  if (ctx.room) {
    parts.push(
      ctx.kids !== undefined
        ? sms(locale, "checkinRoomKids", { room: ctx.room, kids: ctx.kids })
        : sms(locale, "checkinRoom", { room: ctx.room }),
    );
  }
  if (ctx.bus) parts.push(sms(locale, "checkinBus", { bus: ctx.bus }));
  const info = parts.length ? ` ${parts.join(". ")}.` : "";
  const vars = { prefix: smsPrefix(), name: first(staff.name), info, link: appLink() };
  const msg = sms(locale, "checkinDone", vars);
  if (msg.length <= SMS_MAX) return msg;
  return sms(locale, "checkinDoneShort", vars);
}

/**
 * Call right after a team member's check-in is recorded — by themselves
 * (self check-in) or by the admin roll call. Not coalesced: it is a receipt
 * for one action, so it goes out immediately.
 */
export async function notifyCheckin(staff: Staff): Promise<void> {
  try {
    if (!staff.phone && !staff.email) return;
    const settings = await getSettings();
    if (!settings.notifications.checkinConfirmation) return;
    if (!staffHasAccess(staff._id, settings)) return;
    const [room, bus, kidsList] = await Promise.all([
      settings.kidsRoomsDraft ? null : bedroomName(staff.bedroom),
      transportLabel(staff.transportation),
      staff.bedroom && !settings.kidsRoomsDraft ? listCampers({ bedroom: staff.bedroom }) : Promise.resolve([] as Camper[]),
    ]);
    const kids = kidsList.length || undefined;
    if (staff.phone) {
      const locale = await localeForPhone(staff.phone);
      await deliver(staff, composeCheckinSms(staff, { room, kids, bus }, locale), "checkin");
    }
    await mail(staffEmailOf(staff), checkinEmail(staff, { room, bus, kids: kidsList.map((k) => ({ name: k.name })) }), "checkin");
  } catch (err) {
    console.error("notify: check-in confirmation failed", err);
  }
}

// ── check-in reminder → whole team ───────────────────────────────────────────────────

/** "João, chegou a hora do seu check-in! Faça em <app>" */
export function composeCheckinReminderSms(staff: Staff, locale: Locale = "pt"): string {
  return sms(locale, "checkinReminder", { prefix: smsPrefix(), name: first(staff.name), link: appLink() });
}

/**
 * Texts EVERY active team member with a phone reminding them to do their
 * check-in. Runs at `settings.checkinReminder.at` (timer in services/realtime.ts,
 * plus the hourly safety net and boot). Nothing goes out when:
 *   - the `checkinReminder` toggle is off,
 *   - no date is set, or the date is still in the future,
 *   - it already went out for that date (claimed atomically — restarts and
 *     double timers can't text twice; changing the date re-arms it).
 * Not coalesced and not gated by the team access window: the reminder IS the
 * call to show up.
 */
export async function sendCheckinReminder(): Promise<void> {
  try {
    const settings = await getSettings();
    const { at, sentAt } = settings.checkinReminder;
    if (!settings.notifications.checkinReminder || !at || sentAt || at.getTime() > Date.now()) return;
    if (!(await claimCheckinReminder(at))) return;
    const team = (await listStaff({ active: true })).filter((s) => s.phone && !s.checkin);
    console.log(`📲 check-in reminder scheduled for ${at.toISOString()} → texting ${team.length} team members`);
    for (const s of team) await deliver(s, composeCheckinReminderSms(s, await localeForPhone(s.phone)), "checkin-reminder");
  } catch (err) {
    console.error("notify: check-in reminder failed", err);
  }
}

// ── a kid's birthday on a camp day → the whole team of the room ─────────────────────────────

/** São Paulo wall-clock at which the birthday SMS goes out */
export const BIRTHDAY_SMS_TIME = "07:45";

/** "João, hoje é aniversário da Ana (8 anos), do quarto 103! 🎂 Vamos fazer o dia dela especial." */
export function composeBirthdaySms(toName: string, kid: Pick<Camper, "name" | "sex" | "probableGender" | "birthDate">, room: string | null, day: string, locale: Locale = "pt"): string {
  const age = kid.birthDate ? Number(day.slice(0, 4)) - Number(kid.birthDate.slice(0, 4)) : null;
  const fem = (kid.sex ?? kid.probableGender) === "F";
  const of = sms(locale, fem ? "ofHer" : "ofHim");
  const pron = sms(locale, fem ? "her" : "him");
  const build = (withAge: boolean) =>
    sms(locale, "birthday", {
      prefix: smsPrefix(),
      name: first(toName),
      of: of ? `${of} ` : "",
      kid: first(kid.name),
      age: withAge && age ? sms(locale, "birthdayAge", { years: age }) : "",
      room: room ? sms(locale, "birthdayRoom", { room }) : "",
      pron,
    });
  const msg = build(true);
  return msg.length <= SMS_MAX ? msg : build(false);
}

/**
 * The instant (real) at which today's birthday SMS is due: BIRTHDAY_SMS_TIME
 * São Paulo on `day`.
 */
export function birthdaySmsDue(day: string): Date {
  return new Date(saoPauloWallClockToIso(saoPauloWallClock(day, BIRTHDAY_SMS_TIME)));
}

/**
 * Texts EVERY active team member sleeping in the room of a kid whose birthday
 * is TODAY (a camp day), from 07:45 São Paulo on. Runs from the daily timer
 * (services/realtime.ts), the hourly safety net and boot. Nothing goes out when:
 *   - the `birthdays` toggle is off, or the rooms are still a draft,
 *   - today is not a camp day, or it is before 07:45,
 *   - it already went out for that kid on that day (claimed atomically).
 * Not coalesced; the room staff is gated by the team access window like every
 * other text.
 */
export async function sendBirthdayNotices(now = new Date()): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.birthdays || settings.kidsRoomsDraft) return;
    const period = await campPeriod();
    const today = todayInSaoPaulo(now);
    if (!period.from || !period.until || today < period.from || today > period.until) return;
    if (now < birthdaySmsDue(today)) return;
    const kids = (await listCampers()).filter((k) => k.bedroom && birthdayDuringCamp(k.birthDate, period) === today);
    if (kids.length === 0) return;
    const staff = (await listStaff({ active: true })).filter((s) => s.bedroom);
    const allKids = await listCampers();
    for (const kid of kids) {
      if (!(await claimBirthdayNotice(kid._id, today))) continue;
      const room = await bedroomName(kid.bedroom);
      const team = staff.filter((s) => s.bedroom === kid.bedroom && staffHasAccess(s._id, settings));
      const roomKids = allKids.filter((k) => k.bedroom === kid.bedroom).map((k) => k.name);
      const roomStaff = team.map((s) => s.name);
      console.log(`🎂 birthday of ${kid.name} today → texting ${team.filter((s) => s.phone).length} team members of room ${room ?? kid.bedroom}`);
      for (const s of team) {
        if (s.phone) await deliver(s, composeBirthdaySms(s.name, kid, room, today, await localeForPhone(s.phone)), "birthday");
        await mail(staffEmailOf(s), birthdayEmail(s.name, kid, room, today, roomKids, roomStaff), "birthday");
      }
    }
  } catch (err) {
    console.error("notify: birthday notices failed", err);
  }
}

// ── a parent edited their kid's "Informações de saúde" ────────────────────────────────

/**
 * The parent-edit text — who edited what on which kid, then the app link.
 * The values stay in the app (they may be long and sensitive).
 */
export function composeParentEditSms(toName: string, kid: Camper, entry: Pick<CamperChangeLog, "byName" | "medical" | "changes">, locale: Locale = "pt"): string {
  const fields = [...new Set(entry.changes.map((x) => parentFieldLabel(locale, x.field)))];
  const key = entry.medical ? "parentEditMedical" : "parentEditNotes";
  const build = (list: string) =>
    sms(locale, key, {
      prefix: smsPrefix(),
      name: first(toName),
      by: first(entry.byName),
      kid: first(kid.name),
      list: list ? ` (${list})` : "",
      link: appLink(),
    });
  const msg = build(fields.join(", "));
  return msg.length <= SMS_MAX ? msg : build("");
}

/**
 * Call right after a parent's edit is saved. MEDICAL fields changed → the
 * medical team, every admin and the kid's caretaker; only the observations
 * changed → the caretaker alone. Not coalesced: it is about ONE kid and the
 * team may need to act before the camp. The caretaker is gated by the team
 * access window like every other text (people on admin lists never are).
 */
export async function notifyParentEdit(kid: Camper, entry: Pick<CamperChangeLog, "byName" | "medical" | "changes">): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.parentEdits) return;
    const sent = new Set<string>();
    const mailed = new Set<string>();
    const labelOf = await optionLabelOf();
    const send = async (to: { _id: string; name: string; phone: string | null; email?: string | null }, label: string) => {
      if (to.phone && !sent.has(to.phone)) {
        sent.add(to.phone);
        await deliver(to, composeParentEditSms(to.name, kid, entry, await localeForPhone(to.phone)), label);
      }
      const address = to.email?.trim() || (to.phone ? await adminEmailOf(to) : "");
      if (address && !mailed.has(address)) {
        mailed.add(address);
        await mail(address, parentEditEmail(to.name, kid, entry, labelOf), label);
      }
    };
    const caretaker = kid.caretakerId ? await findStaffById(kid.caretakerId) : null;
    if (caretaker?.active && staffHasAccess(caretaker._id, settings)) await send(caretaker, "parent-edit");
    if (!entry.medical) return;
    const staff = await listStaff({ active: true });
    for (const s of staff) if (settings.medicalStaff.staffIds.includes(s._id)) await send(s, "parent-edit-medical");
    for (const admin of await listAdmins()) await send(admin, "parent-edit-admin");
  } catch (err) {
    console.error("notify: parent edit failed", err);
  }
}

// ── occurrence registered → admins ─────────────────────────────────────────────────────

/** "Maria e João" / "Maria, João +2" — first names of the people involved */
function peopleLabel(people: { name: string }[], locale: Locale = "pt"): string {
  const names = people.map((p) => first(p.name));
  if (names.length <= 2) return names.join(sms(locale, "and"));
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/**
 * The occurrence text — who registered it and who is involved, then the app
 * link. The description stays in the app (it may be long and sensitive).
 */
export function composeOccurrenceSms(adminName: string, o: Occurrence, locale: Locale = "pt"): string {
  const campers = o.campers.length
    ? `${sms(locale, o.campers.length > 1 ? "camperPlural" : "camperSingular")} ${peopleLabel(o.campers, locale)}`
    : "";
  const team = o.staff.length ? `${sms(locale, "staffTeam")} ${peopleLabel(o.staff, locale)}` : "";
  const who = [campers, team].filter(Boolean).join(sms(locale, "and"));
  const build = (w: string) =>
    sms(locale, "occurrence", {
      prefix: smsPrefix(),
      name: first(adminName),
      by: first(o.createdByName),
      who: w ? ` (${w})` : "",
      link: appLink(),
    });
  const msg = build(who);
  return msg.length <= SMS_MAX ? msg : build("");
}

/**
 * Call right after an occurrence is inserted. Texts EVERY admin account
 * (except the one who registered it). Not coalesced: an occurrence is an
 * incident, so it goes out immediately. Admins are never gated by the team window.
 */
export async function notifyOccurrence(o: Occurrence): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.occurrences) return;
    for (const admin of await listAdmins()) {
      if (admin._id === o.createdByUserId) continue;
      if (admin.phone) await deliver(admin, composeOccurrenceSms(admin.name, o, await localeForPhone(admin.phone)), "occurrence");
      await mail(await adminEmailOf(admin), occurrenceEmail(admin.name, o), "occurrence");
    }
  } catch (err) {
    console.error("notify: occurrence failed", err);
  }
}

/**
 * SMS when a team member has scanned ≥3 kids OUTSIDE their normal scope
 * (emergency QR lookup). Always sent — not gated by the occurrences toggle
 * (this is a security alert, not an occurrence). Once per streak until the
 * admin zeroes the counter in Settings → Geral.
 */
export function composeForeignLookupSms(adminName: string, staffName: string, count: number, kidNames: string[], locale: Locale = "pt"): string {
  const kids = kidNames.slice(0, 3).map(first).join(", ");
  const extra = kidNames.length > 3 ? ` +${kidNames.length - 3}` : "";
  const key = count === 1 ? "foreignLookup" : "foreignLookupPlural";
  const build = (list: string) =>
    sms(locale, key, {
      prefix: smsPrefix(),
      name: first(adminName),
      staff: first(staffName),
      count,
      list: list ? ` (${list}${extra})` : "",
      link: appLink(),
    });
  const msg = build(kids);
  return msg.length <= SMS_MAX ? msg : build("");
}

export async function notifyForeignLookupAlert(staff: Pick<Staff, "_id" | "name">, count: number, kidNames: string[]): Promise<void> {
  try {
    for (const admin of await listAdmins()) {
      if (!admin.phone) continue;
      await deliver(admin, composeForeignLookupSms(admin.name, staff.name, count, kidNames, await localeForPhone(admin.phone)), "foreign-lookup");
    }
  } catch (err) {
    console.error("notify: foreign-lookup alert failed", err);
  }
}

// ── caretaker changes ─────────────────────────────────────────────────────

async function countKidsOf(caretakerId: string): Promise<number> {
  const { listCampers } = await import("../models/campers");
  return (await listCampers({ caretakerId })).length;
}

/**
 * Call after a camper write with the record BEFORE and AFTER (null on create /
 * delete). Only `caretakerId` matters: the caretaker who LOST the kid and the
 * one who RECEIVED it are texted. Helpers and the other caretakers of the
 * room are never texted — they see it in the app.
 */
export async function notifyCamperChange(before: Camper | null, after: Camper | null): Promise<void> {
  try {
    const from = before?.caretakerId ?? null;
    const to = after?.caretakerId ?? null;
    if (from === to) return;
    const settings = await getSettings();
    if (!settings.notifications.bedroomChanges) return;
    if (settings.kidsRoomsDraft) return; // rooms still being drafted: caretakers can't see the kids anyway

    const kid = (after ?? before)!;
    const [lost, got] = await Promise.all([from ? findStaffById(from) : null, to ? findStaffById(to) : null]);
    if (lost?.active) {
      const locale = await localeForPhone(lost.phone);
      const text = got
        ? sms(locale, "kidLostTo", { kid: first(kid.name), to: first(got.name) })
        : sms(locale, "kidLost", { kid: first(kid.name) });
      await enqueue(lost, "bedroom", text, settings);
    }
    if (got?.active && after) {
      const [room, n, locale] = await Promise.all([bedroomName(after.bedroom), countKidsOf(got._id), localeForPhone(got.phone)]);
      const text = room
        ? sms(locale, "kidGainedRoom", { kid: first(after.name), room, n, s: n === 1 ? "" : sms(locale, "kidPluralSuffix") })
        : sms(locale, "kidGained", { kid: first(after.name), n });
      await enqueue(got, "bedroom", text, settings);
    }
  } catch (err) {
    console.error("notify: camper change failed", err);
  }
}

/**
 * Several kids changed hands at once (a caretaker moved rooms — see
 * POST /api/staff/:id/move). One line for the caretaker who lost them and one
 * for the one who received them (`to` null = the kids became orphans).
 */
export async function notifyCaretakerChange(kids: Camper[], from: Staff, to: Staff | null): Promise<void> {
  try {
    if (kids.length === 0) return;
    const settings = await getSettings();
    if (!settings.notifications.bedroomChanges || settings.kidsRoomsDraft) return;
    const n = kids.length;
    if (from.active) {
      const locale = await localeForPhone(from.phone);
      const names = peopleLabel(kids, locale);
      const verb = sms(locale, n === 1 ? "verbIsOne" : "verbIsMany");
      const text = to
        ? sms(locale, "kidsLostTo", { names, verb, to: first(to.name) })
        : sms(locale, "kidsLost", { names, verb });
      await enqueue(from, "bedroom", text, settings);
    }
    if (to?.active) {
      const [room, locale] = await Promise.all([bedroomName(kids[0].bedroom), localeForPhone(to.phone)]);
      const names = peopleLabel(kids, locale);
      const verb = sms(locale, n === 1 ? "verbBecameOne" : "verbBecameMany");
      const text = room
        ? sms(locale, "kidsGainedRoom", { names, verb, room })
        : sms(locale, "kidsGained", { names, verb });
      await enqueue(to, "bedroom", text, settings);
    }
  } catch (err) {
    console.error("notify: caretaker change failed", err);
  }
}

// ── the person's own allocation (room / team / bus) ─────────────────────────────────────

/**
 * Call after a staff update with the record BEFORE and AFTER. Texts the person
 * themselves when their bedroom, team or vehicle changed, naming the new one.
 * Room changes are muted while the kids' rooms are still a draft (Settings → Geral).
 */
export async function notifyStaffChange(before: Staff, after: Staff): Promise<void> {
  try {
    if (!after.active || !after.phone) return;
    const settings = await getSettings();
    if (!settings.notifications.staffChanges) return;
    const locale = await localeForPhone(after.phone);
    if (before.bedroom !== after.bedroom && !settings.kidsRoomsDraft) {
      const room = await bedroomName(after.bedroom);
      await enqueue(after, "myRoom", room ? sms(locale, "myRoomNow", { room }) : sms(locale, "myRoomNone"), settings);
    }
    if (before.roomRole !== after.roomRole) {
      const text = after.roomRole === "caretaker" ? sms(locale, "myRoomRoleCaretaker") : sms(locale, "myRoomRoleHelper");
      await enqueue(after, "myRoomRole", text, settings);
    }
    if (before.team !== after.team) {
      const team = after.team ? (await findTeamById(after.team))?.name ?? null : null;
      await enqueue(after, "myTeam", team ? sms(locale, "myTeamNow", { team }) : sms(locale, "myTeamNone"), settings);
    }
    if (before.transportation !== after.transportation) {
      const bus = await transportLabel(after.transportation);
      await enqueue(after, "myBus", bus ? sms(locale, "myBusNow", { bus }) : sms(locale, "myBusNone"), settings);
    }
  } catch (err) {
    console.error("notify: staff change failed", err);
  }
}

// ── "montar quartos" applied: the whole delta at once ──────────────────────────

/** One person's slice of the bulk room apply — only the facts that may be texted. */
export interface RoomsPersonChange {
  name: string;
  /** present = the person's own bedroom changed ("after" null = they now have none) */
  room?: { after: string | null };
  /** present = the room role changed — the NEW role */
  role?: RoomRole;
  /** the kids under their care: names gained / lost, or all kept through a move */
  kids?: { gained: string[]; lost: string[]; sameAfterMove: boolean };
}

/** "Maria e João" / "Maria, João +2" — first names of a list of names */
function namesLabel(names: string[], locale: Locale = "pt"): string {
  return peopleLabel(names.map((name) => ({ name })), locale);
}

/**
 * The bulk-apply SMS: ONE text per person describing their whole situation
 * after the change — new room, new role and what happened to their kids —
 * packed into a single segment. Falls back from names to counts when the
 * detailed version does not fit.
 */
export function composeRoomsAppliedSms(p: RoomsPersonChange, locale: Locale = "pt"): string {
  const facts: string[] = [];
  if (p.room) facts.push(p.room.after ? sms(locale, "myRoomNow", { room: p.room.after }) : sms(locale, "myRoomNone"));
  if (p.role) facts.push(p.role === "caretaker" ? sms(locale, "myRoomRoleCaretaker") : sms(locale, "myRoomRoleHelper"));
  const g = p.kids?.gained ?? [];
  const l = p.kids?.lost ?? [];
  const be = (n: number) => sms(locale, n === 1 ? "verbIsOne" : "verbIsMany");
  const detailed = () => {
    if (g.length && l.length) {
      return sms(locale, "roomsKidsGainedLost", {
        gained: namesLabel(g, locale),
        gVerb: be(g.length),
        lost: namesLabel(l, locale),
        lVerb: be(l.length),
      });
    }
    if (g.length) return sms(locale, "roomsKidsGained", { gained: namesLabel(g, locale), gVerb: be(g.length) });
    if (l.length) return sms(locale, "roomsKidsLost", { lost: namesLabel(l, locale), lVerb: be(l.length) });
    if (p.kids?.sameAfterMove) return sms(locale, "roomsKidsSame");
    return null;
  };
  const counted = () => {
    if (g.length && l.length) {
      return sms(locale, "roomsKidsCountGainLose", {
        g: g.length,
        l: l.length,
        kids: sms(locale, g.length + l.length === 1 ? "childSingular" : "childPlural"),
      });
    }
    if (g.length) return sms(locale, "roomsKidsCountGain", { g: g.length, kids: sms(locale, g.length === 1 ? "childNewSingular" : "childNewPlural") });
    if (l.length) return sms(locale, "roomsKidsCountLose", { l: l.length, kids: sms(locale, l.length === 1 ? "childSingular" : "childPlural") });
    if (p.kids?.sameAfterMove) return sms(locale, "roomsKidsSame");
    return null;
  };
  const render = (kids: string | null) =>
    `${smsPrefix()}: ${first(p.name)}, ${[...facts, kids].filter(Boolean).join("; ")}. ${sms(locale, "seeIn", { link: appLink() })}`;
  for (const kids of [detailed(), counted(), null]) {
    const msg = render(kids);
    if (msg.length <= SMS_MAX) return msg;
  }
  return clip(render(null), SMS_MAX);
}

/**
 * Call after POST /api/bedrooms/apply applied the whole "montar quartos"
 * delta, with the staff + campers lists from BEFORE and AFTER. Texts every
 * team member concerned — ONE well-thought SMS each (not coalesced: the
 * apply is a single deliberate action) covering everything that changed for
 * them: their room, their role and the kids under their care. Same gates as
 * the individual writes (staffChanges / bedroomChanges, the kids-rooms
 * draft mutes room and kid texts) and the team access window.
 */
/** One team member who WOULD be texted by the apply: the exact SMS they'd get. */
export interface RoomsAppliedMessage {
  staffId: string;
  name: string;
  text: string;
  change: RoomsPersonChange;
}

/**
 * Pure core of notifyRoomsApplied: given the before/after state + settings +
 * the rooms, work out exactly who gets an SMS and what it says. Same gates as
 * the delivery (staffChanges / bedroomChanges, the kids-rooms draft, the team
 * access window). Used both to SEND (notifyRoomsApplied) and to PREVIEW the
 * texts on the Concluir dialog, so the two can never drift.
 */
export function roomsAppliedMessages(
  before: { staff: Staff[]; campers: Camper[] },
  after: { staff: Staff[]; campers: Camper[] },
  settings: Settings,
  rooms: Bedroom[],
): RoomsAppliedMessage[] {
  const out: RoomsAppliedMessage[] = [];
  const n = settings.notifications;
  if (!n.staffChanges && !n.bedroomChanges) return out;
  const roomName = (id: string | null) => (id ? rooms.find((b) => b._id === id)?.name ?? null : null);
  const beforeStaff = new Map(before.staff.map((s) => [s._id, s]));
  const kidsBeforeOf = new Map<string, Camper[]>();
  for (const k of before.campers) {
    if (!k.caretakerId) continue;
    const list = kidsBeforeOf.get(k.caretakerId) ?? [];
    list.push(k);
    kidsBeforeOf.set(k.caretakerId, list);
  }
  const kidsAfterOf = new Map<string, Camper[]>();
  for (const k of after.campers) {
    if (!k.caretakerId) continue;
    const list = kidsAfterOf.get(k.caretakerId) ?? [];
    list.push(k);
    kidsAfterOf.set(k.caretakerId, list);
  }
  for (const s of after.staff) {
    const was = beforeStaff.get(s._id);
    if (!was || !s.active || !s.phone) continue;
    const kidsBefore = kidsBeforeOf.get(s._id) ?? [];
    const kidsAfter = kidsAfterOf.get(s._id) ?? [];
    const beforeIds = new Set(kidsBefore.map((k) => k._id));
    const afterIds = new Set(kidsAfter.map((k) => k._id));
    const gained = kidsAfter.filter((k) => !beforeIds.has(k._id));
    const lost = kidsBefore.filter((k) => !afterIds.has(k._id));
    const roomChanged = was.bedroom !== s.bedroom;
    const roleChanged = was.roomRole !== s.roomRole;
    if (!roomChanged && !roleChanged && !gained.length && !lost.length) continue;
    const showRoom = roomChanged && n.staffChanges && !settings.kidsRoomsDraft;
    const showRole = roleChanged && n.staffChanges;
    const sameAfterMove = roomChanged && !gained.length && !lost.length && kidsAfter.length > 0;
    const showKids = n.bedroomChanges && !settings.kidsRoomsDraft && (!!gained.length || !!lost.length || sameAfterMove);
    if (!showRoom && !showRole && !showKids) continue;
    if (!staffHasAccess(s._id, settings)) continue;
    const change: RoomsPersonChange = { name: s.name };
    if (showRoom) change.room = { after: roomName(s.bedroom) };
    if (showRole) change.role = s.roomRole;
    if (showKids) change.kids = { gained: gained.map((k) => k.name), lost: lost.map((k) => k.name), sameAfterMove };
    out.push({ staffId: s._id, name: s.name, text: composeRoomsAppliedSms(change), change });
  }
  return out;
}

export async function notifyRoomsApplied(
  before: { staff: Staff[]; campers: Camper[] },
  after: { staff: Staff[]; campers: Camper[] },
): Promise<void> {
  try {
    const settings = await getSettings();
    const rooms = await listBedrooms();
    const staffById = new Map(after.staff.map((s) => [s._id, s]));
    for (const m of roomsAppliedMessages(before, after, settings, rooms)) {
      const s = staffById.get(m.staffId);
      if (!s) continue;
      if (s.phone) await deliver(s, composeRoomsAppliedSms(m.change, await localeForPhone(s.phone)), "rooms-apply");
      await mail(staffEmailOf(s), roomsAppliedEmail(s.name, m.change), "rooms-apply");
    }
  } catch (err) {
    console.error("notify: rooms apply failed", err);
  }
}

// ── role (event function) changes ───────────────────────────────────────────

interface Duty {
  roleId: string;
  detail: string;
}

/**
 * What each staff member does in the event: explicit assignment, else the
 * automatic role that covers their POSITION (líder / auxiliar / whole team;
 * active only). A role whose detail is the person's team takes its label from
 * the staff record, so the text says the team.
 */
function dutiesOf(e: CampEvent | null, staff: Staff[], roleById: Map<string, ScheduleRole>, teamById: Map<string, Team>): Map<string, Duty> {
  const out = new Map<string, Duty>();
  if (!e) return out;
  for (const s of staff) {
    const a = e.assignments.find((x) => x.staffId === s._id);
    if (a) out.set(s._id, { roleId: a.roleId, detail: assignmentDetail(roleById.get(a.roleId), a, s, teamById).detail });
    else if (s.active) {
      const auto = autoRoleFor(e, s.roomRole, roleById);
      if (auto) out.set(s._id, { roleId: auto._id, detail: "" });
    }
  }
  return out;
}

/**
 * Call after an event write with the event BEFORE and AFTER (null on create /
 * delete). Diffs each person's duty and texts the ones whose duty changed —
 * or, when the event itself moved (date / time), everyone who has a duty in it.
 * The text names the event, when it is and what the person does there.
 */
export async function notifyEventChange(before: CampEvent | null, after: CampEvent | null): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.roleChanges) return;

    const [staff, roles, teams] = await Promise.all([listStaff(), listRoles(), listTeams()]);
    const roleById = new Map(roles.map((r) => [r._id, r]));
    const teamById = teamMap(teams);
    const prev = dutiesOf(before, staff, roleById, teamById);
    const next = dutiesOf(after, staff, roleById, teamById);
    const moved = !!before && !!after && (before.date !== after.date || before.startTime !== after.startTime || before.endTime !== after.endTime);
    for (const s of staff) {
      const a = prev.get(s._id);
      const b = next.get(s._id);
      const locale = await localeForPhone(s.phone);
      const duty = (d: Duty) => dutyLabel(d.roleId, d.detail, roleById, locale);
      let text: string | null = null;
      if (b && !a) text = sms(locale, "roleAssigned", { event: eventLabel(after!, locale), duty: duty(b) });
      else if (a && !b && !after) text = sms(locale, "roleEventCancelled", { event: eventLabel(before!, locale) });
      else if (a && !b) text = sms(locale, "roleLeft", { event: eventLabel(after ?? before!, locale) });
      else if (a && b && (a.roleId !== b.roleId || a.detail !== b.detail)) text = sms(locale, "roleChanged", { event: eventLabel(after!, locale), duty: duty(b) });
      else if (b && moved) text = sms(locale, "roleMoved", { title: before!.title, when: `${shortDate(after!.date, locale)} ${after!.startTime}`, duty: duty(b) });
      if (text) await enqueue(s, "role", text, settings);
    }
  } catch (err) {
    console.error("notify: event change failed", err);
  }
}

/**
 * A role was edited → everyone who does it in some event (explicitly, or via
 * "for everyone"). Which switch applies depends on WHAT changed:
 *   name / forRoomRoles → roleChanges, instructions / preparation → contentChanges.
 */
export async function notifyRoleEdited(roleBefore: ScheduleRole, roleAfter: ScheduleRole, events: CampEvent[]): Promise<void> {
  try {
    const settings = await getSettings();
    const n = settings.notifications;
    if (!n.roleChanges && !n.contentChanges) return;

    const staff = await listStaff({ active: true });
    const using = events.filter((e) => e.roles.includes(roleAfter._id));
    for (const s of staff) {
      const concerned = using.some((e) => {
        const a = e.assignments.find((x) => x.staffId === s._id);
        // automatic role: only the positions it covers (before or after the edit) are concerned
        return a ? a.roleId === roleAfter._id : autoRoleCovers(roleAfter, s.roomRole) || autoRoleCovers(roleBefore, s.roomRole);
      });
      if (!concerned) continue;
      const locale = await localeForPhone(s.phone);
      const items: Item[] = [];
      if (n.roleChanges && roleBefore.name !== roleAfter.name) items.push({ kind: "role", text: sms(locale, "roleRenamed", { before: roleBefore.name, after: roleAfter.name }) });
      if (n.roleChanges && roleBefore.forRoomRoles.join() !== roleAfter.forRoomRoles.join()) {
        items.push({
          kind: "role",
          text: isAutomatic(roleAfter)
            ? sms(locale, "roleNowAuto", { role: roleAfter.name, audience: autoAudienceLabel(roleAfter) })
            : sms(locale, "roleNowManual", { role: roleAfter.name }),
        });
      }
      if (n.contentChanges && roleBefore.instructions !== roleAfter.instructions) items.push({ kind: "instructions", text: sms(locale, "instructionsUpdated", { title: roleAfter.name }) });
      if (n.contentChanges && roleBefore.preparation !== roleAfter.preparation) items.push({ kind: "preparation", text: sms(locale, "prepUpdated", { title: roleAfter.name }) });
      for (const i of items) await enqueue(s, i.kind, i.text, settings);
      if (n.contentChanges && roleBefore.instructions !== roleAfter.instructions) {
        await mail(staffEmailOf(s), roleDocEmail(s.name, roleAfter, "instructions"), "role-instructions");
      }
      if (n.contentChanges && roleBefore.preparation !== roleAfter.preparation) {
        await mail(staffEmailOf(s), roleDocEmail(s.name, roleAfter, "preparation"), "role-preparation");
      }
    }
  } catch (err) {
    console.error("notify: role edit failed", err);
  }
}

// ── general documents (Instruções / Preparação) ─────────────────────────────

/** the whole active team, or only the caretakers / helpers when the document has a narrower audience */
async function notifyEveryone(kind: NotifyKind, textFor: (locale: Locale) => string, enabled: (n: Settings["notifications"]) => boolean, audience: DocAudience = "all"): Promise<void> {
  const settings = await getSettings();
  if (!enabled(settings.notifications)) return;
  for (const s of await listStaff({ active: true })) {
    if (audience === "all" || s.roomRole === audience) await enqueue(s, kind, textFor(await localeForPhone(s.phone)), settings);
  }
}

/** A general instructions document was created or its title / content changed → the whole active team. */
export async function notifyInstructionChange(before: InstructionDoc | null, after: InstructionDoc): Promise<void> {
  try {
    if (before && before.title === after.title && before.content === after.content) return; // reorder / emoji only
    const textFor = (locale: Locale) =>
      !before
        ? sms(locale, "instructionsNew", { title: after.title })
        : before.title !== after.title
          ? sms(locale, "instructionsRenamed", { before: before.title, after: after.title })
          : sms(locale, "instructionsUpdated", { title: after.title });
    await notifyEveryone("instructions", textFor, (n) => n.contentChanges, after.audience);
    const settings = await getSettings();
    if (settings.notifications.contentChanges) {
      for (const s of await listStaff({ active: true })) {
        if (after.audience !== "all" && s.roomRole !== after.audience) continue;
        await mail(staffEmailOf(s), instructionEmail(s.name, after, !before), "instructions");
      }
    }
  } catch (err) {
    console.error("notify: instruction change failed", err);
  }
}

/**
 * A Preparação section was created, its title / content changed, or it was
 * posted to a new group. The team members in its audiences are texted
 * (`contentChanges`); when it is posted to the PARENTS every parent with a
 * phone is texted too (`parentContentChanges`) — only while the parents'
 * access window is open (checked at send time, like the team's window).
 * Somebody who just LOST the section (audience removed) is not texted.
 */
export async function notifyPreparationChange(before: PrepSection | null, after: PrepSection): Promise<void> {
  try {
    const changed = !before || before.title !== after.title || before.content !== after.content;
    const gained = (a: PrepAudience) => after.audiences.includes(a) && (!before || !before.audiences.includes(a));
    const isNew = (a: PrepAudience) => !before || gained(a);
    const textFor = (a: PrepAudience, locale: Locale) =>
      isNew(a)
        ? sms(locale, "prepNew", { title: after.title })
        : before!.title !== after.title
          ? sms(locale, "prepRenamed", { before: before!.title, after: after.title })
          : sms(locale, "prepUpdated", { title: after.title });
    const concerned = (a: PrepAudience) => after.audiences.includes(a) && (changed || gained(a));
    if (!PREP_AUDIENCES.some(concerned)) return;

    const settings = await getSettings();
    const n = settings.notifications;
    if (n.contentChanges && (concerned("caretaker") || concerned("helper"))) {
      for (const s of await listStaff({ active: true })) {
        if (!concerned(s.roomRole)) continue;
        await enqueue(s, "preparation", textFor(s.roomRole, await localeForPhone(s.phone)), settings);
        await mail(staffEmailOf(s), prepEmail(s.name, after, isNew(s.roomRole)), "preparation");
      }
    }
    if (n.parentContentChanges && concerned("parent")) {
      for (const p of await listParents()) {
        await enqueueParent(p, "preparation", textFor("parent", p.locale), settings);
        await mail(await parentEmailOf(p.phone), parentPrepEmail(p.name, after, isNew("parent")), "parent-prep");
      }
    }
  } catch (err) {
    console.error("notify: preparation change failed", err);
  }
}

/**
 * The photographer published photos in the album (Fotos tab). Everyone is
 * nudged ONCE for the whole camp: the whole active TEAM (each inside their
 * access window) and every PARENT with a phone (inside the parents' window).
 * The stamp lives on the person (`photosSmsSentAt`), so publishing more
 * batches later — or hiding and publishing again — never texts them twice;
 * whoever was outside their window at the time is still eligible later.
 * Nothing goes out when the photos are hidden.
 */
export async function notifyPhotosPublished(count: number): Promise<void> {
  try {
    if (count <= 0) return;
    const settings = await getSettings();
    if (!settings.notifications.photoPublishes) return;
    for (const s of await listStaff({ active: true })) {
      if (!s.phone || !staffHasAccess(s._id, settings)) continue; // claim only for someone who will really be texted
      if (await claimStaffPhotosNotice(s._id)) await enqueue(s, "photos", sms(await localeForPhone(s.phone), "photos"), settings);
    }
    for (const p of await listParents()) {
      if (!p.phone || !staffAccessOpen(settings.parentAccessWindow)) continue;
      if (await claimParentPhotosNotice(p._id)) await enqueueParent(p, "photos", sms(p.locale, "photos"), settings);
    }
  } catch (err) {
    console.error("notify: photos published failed", err);
  }
}

// ── parents: the kid boarded the bus ─────────────────────────────────────────

/**
 * "Maria, a Ana está a caminho de um fim de semana incrível para aprender
 * sobre Jesus! Aproveite o fim de semana livre e fique tranquila: vamos
 * cuidar muito bem dela." — gendered by the kid's `sex` ("dele" / "dela").
 * Exported so the admin panel shows the exact text.
 */
export function composeBusCheckinSms(kid: Pick<Camper, "name" | "sex" | "probableGender" | "guardianName">, locale: Locale = "pt"): string {
  const fem = (kid.sex ?? kid.probableGender) === "F";
  const article = sms(locale, fem ? "theF" : "theM");
  const pron = sms(locale, fem ? "her" : "him");
  const to = first(kid.guardianName || "");
  const build = (greet: string) =>
    sms(locale, "busCheckin", {
      prefix: smsPrefix(),
      greet,
      article: article ? `${article} ` : "",
      kid: first(kid.name),
      pron,
    });
  const msg = build(to ? `${to}, ` : "");
  return msg.length <= SMS_MAX ? msg : build("");
}

/**
 * Call right after a kid's BUS check-in is recorded. Texts the guardian
 * (`Camper.guardianPhone`). Not coalesced; undoing a check-in sends nothing.
 * Parents are never texted about anything else (rooms, roles…).
 */
export async function notifyBusCheckin(kid: Camper): Promise<void> {
  try {
    if (!kid.guardianPhone && !kid.guardianEmail) return;
    const settings = await getSettings();
    if (!settings.notifications.busCheckin) return;
    if (kid.guardianPhone) {
      const locale = await localeForPhone(kid.guardianPhone);
      await deliver(
        { name: kid.guardianName || sms(locale, "guardianOf", { name: first(kid.name) }), phone: kid.guardianPhone },
        composeBusCheckinSms(kid, locale),
        "bus-checkin",
        "parent",
      );
    }
    const contacts = await parentContactsForEmail();
    await mail(await parentEmailOf(kid.guardianPhone, kid.guardianEmail), busCheckinEmail(kid, contacts), "bus-checkin");
  } catch (err) {
    console.error("notify: bus check-in failed", err);
  }
}

// ── parents: welcome (app link) ──────────────────────────────────────────────

/** "Maria, a Ana está inscrita no Acampa Kids! Acompanhe tudo pelo app. Entre com o celular (11) 9… em <app>" */
export function composeParentWelcomeSms(parent: { name: string; phone: string }, kids: Pick<Camper, "name" | "sex" | "probableGender">[], locale: Locale = "pt"): string {
  const names = kids.map((k) => first(k.name));
  const fem = (k: Pick<Camper, "sex" | "probableGender">) => (k.sex ?? k.probableGender) === "F";
  const who =
    kids.length === 0
      ? sms(locale, "parentWelcomeFallback")
      : kids.length === 1
        ? sms(locale, fem(kids[0]) ? "enrolledF" : "enrolledM", { name: names[0] })
        : sms(locale, kids.every(fem) ? "enrolledFp" : "enrolledMp", {
            names: `${names.slice(0, -1).join(", ")}${sms(locale, "and")}${names[names.length - 1]}`,
          });
  const body = (w: string) => sms(locale, kids.length > 1 ? "parentWelcomeMany" : "parentWelcomeOne", { who: w });
  const full = (w: string, phone: string) =>
    `${smsPrefix()}: ${first(parent.name)}, ${body(w)}${phone ? sms(locale, "parentWelcomeEnterPhone", { phone, link: appLink() }) : sms(locale, "parentWelcomeEnter", { link: appLink() })}`;
  const fallback = sms(locale, "parentWelcomeFallback");
  for (const msg of [full(who, formatBrazilPhone(parent.phone)), full(who, ""), full(fallback, "")]) if (msg.length <= SMS_MAX) return msg;
  return full(fallback, "");
}

/** the parents who would be welcomed right now: parent role, a phone, never welcomed (the window is checked by the caller) */
async function pendingParentWelcomes(): Promise<{ id: string; name: string; phone: string; kids: Pick<Camper, "name" | "sex" | "probableGender">[] }[]> {
  const [parents, kids] = await Promise.all([listParents(), listCampers()]);
  const kidsOf = new Map<string, Pick<Camper, "name" | "sex" | "probableGender">[]>();
  for (const k of kids) if (k.guardianPhone) kidsOf.set(k.guardianPhone, [...(kidsOf.get(k.guardianPhone) ?? []), { name: k.name, sex: k.sex, probableGender: k.probableGender }]);
  return parents.filter((p) => !p.welcomeSentAt && p.phone && kidsOf.has(p.phone)).map((p) => ({ id: p._id, name: p.name, phone: p.phone, kids: kidsOf.get(p.phone)! }));
}

/**
 * THE parents' welcome scheduler — same logic as `syncWelcomes` for the
 * team: whoever may use the app right now (parentAccessWindow open) and was
 * never welcomed gets the SMS, ONCE ever (atomic claim). Called at boot, at
 * the window edges, when the window is edited, when the toggle is switched on.
 */
export async function syncParentWelcomes(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.parentWelcome) return;
    if (!staffAccessOpen(settings.parentAccessWindow)) return;
    const windowLabel = accessWindowLabel(settings.parentAccessWindow.from, settings.parentAccessWindow.until);
    for (const p of await pendingParentWelcomes()) {
      if (!(await claimParentWelcome(p.id))) continue;
      await deliver(p, composeParentWelcomeSms(p, p.kids, await localeForPhone(p.phone)), "parent-welcome", "parent");
      await mail(await parentEmailOf(p.phone), parentWelcomeEmail(p, p.kids, windowLabel), "parent-welcome");
    }
  } catch (err) {
    console.error("notify: parent welcome sync failed", err);
  }
}

/**
 * What the admin sees before switching a welcome toggle on: how many people
 * would be texted RIGHT NOW (never welcomed + phone + their window open).
 */
export async function welcomePreview(): Promise<{ staff: { count: number; windowOpen: boolean; names: string[] }; parents: { count: number; windowOpen: boolean; names: string[] } }> {
  const settings = await getSettings();
  const staffOpen = staffAccessOpen(settings.staffAccessWindow);
  const team = (await listStaff({ active: true })).filter((s) => !s.welcomeSentAt && s.phone);
  const parentsOpen = staffAccessOpen(settings.parentAccessWindow);
  const parents = await pendingParentWelcomes();
  return {
    staff: { count: staffOpen ? team.length : 0, windowOpen: staffOpen, names: staffOpen ? team.map((s) => s.name) : [] },
    parents: { count: parentsOpen ? parents.length : 0, windowOpen: parentsOpen, names: parentsOpen ? parents.map((p) => p.name) : [] },
  };
}

// ── enrolment: added to the team / to an admin list ─────────────────────────

/**
 * The enrolment text — says WHICH role the person got (none = the plain
 * welcome, when the team window opens) and ALWAYS carries the app link (with
 * the phone they must log in with), since this is how they find the app.
 */
export function composeEnrolSms(staff: Staff, roles: string[], locale: Locale = "pt"): string {
  const name = first(staff.name);
  const list = roles.length > 1 ? `${roles.slice(0, -1).join(", ")}${sms(locale, "and")}${roles[roles.length - 1]}` : roles[0];
  const what = roles.length ? sms(locale, "enrolRoles", { roles: list }) : sms(locale, "enrolOpen");
  const phone = staff.phone ? formatBrazilPhone(staff.phone) : "";
  const build = (w: string, withPhone: boolean) =>
    `${smsPrefix()}: ${name}, ${w}!${withPhone && phone ? sms(locale, "enrolEnterPhone", { phone, link: appLink() }) : sms(locale, "enrolEnter", { link: appLink() })}`;
  for (const msg of [build(what, true), build(what, false), build(sms(locale, "enrolNewRoles", { count: roles.length }), false)]) {
    if (msg.length <= SMS_MAX) return msg;
  }
  return build(clip(what, 60), false);
}

/**
 * Sends the welcome SMS (app link) to one person — ONCE, ever. The claim is
 * atomic in the database, so restarts, double saves or two triggers firing
 * together can't text twice. Returns true when it went out.
 */
async function sendWelcome(staff: Staff, roles: string[] = []): Promise<boolean> {
  if (!staff.active) return false;
  if (!staff.phone && !(staffEmailOf(staff))) return false;
  if (!(await claimStaffWelcome(staff._id))) return false;
  if (staff.phone) await deliver(staff, composeEnrolSms(staff, roles, await localeForPhone(staff.phone)), roles.length ? "enrol" : "welcome");
  await mail(staffEmailOf(staff), staffWelcomeEmail(staff, roles), roles.length ? "enrol" : "welcome");
  return true;
}

/**
 * THE welcome scheduler. Whoever may use the app right now and has never
 * been welcomed gets the welcome SMS. Call it whenever that set may have
 * grown: boot, the team window (re)opening — via the edge timer in
 * services/realtime.ts — the window being edited, a member created or
 * reactivated. Each person is welcomed at most once (see sendWelcome), no
 * matter how many times the admin moves the window start.
 */
export async function syncWelcomes(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.enrolments) return;
    if (!staffAccessOpen(settings.staffAccessWindow)) return; // people on admin lists were welcomed when listed
    for (const s of await listStaff({ active: true })) {
      if (s.welcomeSentAt || (!s.phone && !(staffEmailOf(s)))) continue;
      await sendWelcome(s);
    }
  } catch (err) {
    console.error("notify: welcome sync failed", err);
  }
}

/** every admin-list membership of one person, as the person reads it */
async function listRolesOf(id: string, s: Settings, locale: Locale = "pt"): Promise<string[]> {
  const out: string[] = [];
  if (s.organizers.staffIds.includes(id)) out.push(sms(locale, "roleOrganizer"));
  if (s.gameOrganizers.staffIds.includes(id)) out.push(sms(locale, "roleGameOrganizer"));
  if (s.scoreHelpers.staffIds.includes(id)) out.push(sms(locale, "roleScoreHelper"));
  if (s.checkinHelpers.staffIds.includes(id)) out.push(sms(locale, "roleCheckinHelper"));
  const bus = s.busHelpers.helpers.find((h) => h.staffId === id);
  if (bus) {
    const v = await transportLabel(bus.vehicleId);
    out.push(v ? sms(locale, "roleBusHelperNamed", { vehicle: v }) : sms(locale, "roleBusHelper"));
  }
  if (s.medicalStaff.staffIds.includes(id)) out.push(sms(locale, "roleMedical"));
  if (s.vestHelpers.staffIds.includes(id)) out.push(sms(locale, "roleVestHelper"));
  if (s.photographers.staffIds.includes(id)) out.push(sms(locale, "rolePhotographer"));
  for (const p of s.parentContacts) if (p.staffId === id) out.push(sms(locale, "roleParentContact", { title: p.title }));
  return out;
}

/**
 * Call after Settings are written with the document BEFORE and AFTER. Texts
 * each person who was ADDED to an admin list (organizers, check-in / bus
 * helpers, medical team, vest helpers, parent contacts) — one SMS per person, naming every
 * list they entered. Being on a list is what lets the person use the app
 * outside the team window, so this is NOT gated by the window. Nobody is
 * texted when they LEAVE a list (or the team): no need to rub it in.
 */
export async function notifyAccessListChange(before: Settings, after: Settings): Promise<void> {
  try {
    if (!after.notifications.enrolments) return;
    const ids = new Set<string>();
    for (const s of [before, after]) {
      for (const id of [...s.organizers.staffIds, ...s.gameOrganizers.staffIds, ...s.scoreHelpers.staffIds, ...s.checkinHelpers.staffIds, ...s.medicalStaff.staffIds, ...s.vestHelpers.staffIds, ...s.photographers.staffIds]) ids.add(id);
      for (const h of s.busHelpers.helpers) ids.add(h.staffId);
      for (const p of s.parentContacts) ids.add(p.staffId);
    }
    if (ids.size === 0) return;

    const staff = await listStaff({ active: true });
    for (const s of staff) {
      if (!ids.has(s._id) || (!s.phone && !(staffEmailOf(s)))) continue;
      const locale = await localeForPhone(s.phone);
      const [was, now] = await Promise.all([listRolesOf(s._id, before, locale), listRolesOf(s._id, after, locale)]);
      const gained = now.filter((r) => !was.includes(r));
      if (!gained.length) continue;
      // a role text carries the link too, so it doubles as the welcome; someone already welcomed still hears about the new role
      if (!(await sendWelcome(s, gained))) {
        if (s.phone) await deliver(s, composeEnrolSms(s, gained, locale), "enrol");
        await mail(staffEmailOf(s), staffWelcomeEmail(s, gained), "enrol");
      }
    }
  } catch (err) {
    console.error("notify: access list change failed", err);
  }
}
