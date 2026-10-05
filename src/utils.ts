import { createHash } from "node:crypto";
import type { Role } from "./types";

/**
 * Normalizes a Brazilian mobile phone number to E.164 (+55DD9XXXXXXXX).
 * Accepts input with or without formatting, with or without country code.
 * Returns null when the number is not a valid Brazilian mobile number.
 */
/** Lower-case email, or null when empty. Invalid returns "" (caller treats as error). */
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

export function normalizeBrazilPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");

  // strip country code if present
  let national = digits;
  if (national.length === 12 || national.length === 13) {
    if (!national.startsWith("55")) return null;
    national = national.slice(2);
  }

  // Brazilian mobile: 2-digit DDD (11-99) + 9 + 8 digits = 11 digits
  if (!/^[1-9][1-9]9\d{8}$/.test(national)) return null;

  return `+55${national}`;
}

// Portuguese particles only — "Di Lella", "Del Bortolo", "Van Der" are written capitalized by the families
const NAME_PARTICLES = new Set(["de", "da", "do", "dos", "das", "e"]);

/**
 * Person names always land in the DB in the same case, whatever the source
 * (spreadsheet, Supabase, admin form, seed): "ANNA SOPHIA DE MUNIZ" →
 * "Anna Sophia de Muniz". Keeps particles lower-case, handles hyphens and
 * apostrophes ("Maria-Clara", "D'Amore"), collapses whitespace.
 */
export function titleCaseName(raw: string): string {
  const cap = (w: string) => (w ? w[0].toLocaleUpperCase("pt-BR") + w.slice(1).toLocaleLowerCase("pt-BR") : w);
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word, i) => {
      const lower = word.toLocaleLowerCase("pt-BR");
      if (i > 0 && NAME_PARTICLES.has(lower)) return lower;
      return lower
        .split("-")
        .map((h) => h.split("'").map(cap).join("'"))
        .join("-");
    })
    .join(" ");
}

/** Formats a Brazilian CPF as 123.456.789-00 (progressive while incomplete). */
export function formatCpf(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** +5511981234567 -> (11) 98123-4567 */
export function formatBrazilPhone(e164: string): string {
  const n = e164.replace(/\D/g, "").replace(/^55/, "");
  const ddd = n.slice(0, 2);
  const rest = n.slice(2);
  return `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
}

/** +5511981234567 -> 5511981234567 (format Comtele expects) */
export function toComtelePhone(e164: string): string {
  return e164.replace(/\D/g, "");
}

/** Great-circle distance in metres between two WGS84 points (haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** "YYYY-MM-DD" of now in the camp's time zone (the server may run anywhere). */
export function todayInSaoPaulo(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Wall-clock of `now` in São Paulo as a comparable number: the SP components
 * laid over Date.UTC. Only meant to be compared with `saoPauloWallClock()`
 * of another time — never as a real instant.
 */
export function nowInSaoPauloWallClock(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
}

/** "YYYY-MM-DD" + "HH:mm" (São Paulo wall-clock) → the same comparable number as `nowInSaoPauloWallClock()` */
export function saoPauloWallClock(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, min);
}

/** wall-clock number → real instant (ISO), assuming Brazil's fixed UTC−3 (no DST since 2019) */
export function saoPauloWallClockToIso(wall: number): string {
  return new Date(wall + 3 * 3600_000).toISOString();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 60_000));
}

/** Highest-privilege role first: the login session acts as the best role the person holds. */
const ROLE_PRIORITY: Role[] = ["admin", "staff", "parent"];
export function pickActiveRole(roles: Role[]): Role {
  return ROLE_PRIORITY.find((r) => roles.includes(r)) ?? roles[0] ?? "parent";
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ["parent", "staff", "admin"].includes(value);
}

/**
 * An "icon" is 1–2 user-perceived characters. One emoji may be many code
 * points (skin tones, ZWJ families, flags), so count graphemes, not length.
 */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function isEmojiLike(v: string): boolean {
  if (!v || /\s/.test(v) || v.length > 32) return false;
  const n = [...graphemes.segment(v)].length;
  return n >= 1 && n <= 2;
}
