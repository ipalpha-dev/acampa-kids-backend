import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateCamp, SAMPLE_KIDS, SAMPLE_STAFF } from "./generateCamp";

/**
 * Decision 92: the wizard sample is fully synthetic. The old `camp.json` held
 * real families' data; these are short hashes (sha256 of the lower-cased,
 * single-spaced text, first 12 hex) of its distinctive free texts — health and
 * care notes, schools, churches, insurances. Only hashes, never the text.
 */
const OLD_SAMPLE_HASHES = new Set([
  "03788f9e9581",
  "11284d6a45db",
  "155f4ed3592e",
  "15aaddbfa9da",
  "17064c5a5d7d",
  "1742603f9c48",
  "205cbb239880",
  "25e3871eca43",
  "289c464ab9eb",
  "2ace7913d9a9",
  "36d9ce39f809",
  "3dc4bf458ace",
  "3eaeb07f0556",
  "48fa5bbdf6d7",
  "4acbc55e0fb6",
  "4fb6c81d8930",
  "5696ea531c65",
  "5aa1274b75f4",
  "5dffbf3ff7c7",
  "62bdd085e4fa",
  "69281e0d1e45",
  "6adffbbe16c5",
  "6e383ce75f89",
  "7060f326e3d1",
  "7625acf221e7",
  "76ed5173c070",
  "775674ef0e42",
  "77a941e5328f",
  "7a55d2e3025f",
  "8178bc07c713",
  "85132e677f2d",
  "8cf8eb830419",
  "903f81088d4a",
  "a5afc44bd53c",
  "abcae1203f90",
  "ba259c4431b9",
  "ba8a789829eb",
  "c2b2aa060838",
  "ca8cdc2f8469",
  "cb19672ef76f",
  "cc759f2e0e54",
  "d30d266621f8",
  "d6741df39df2",
  "dd8a2796c8b8",
  "e2340895b613",
  "e44b5d35c26e",
  "e4e0190bffef",
  "ea4afe237cf5",
  "ed77ef5a0f2f"
]);

const hash = (s: string) => createHash("sha256").update(s.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 12);

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

const PHONE = /^\+55 11 90000-00\d{2}$/;
const camp = generateCamp({ seed: 2026, year: 2026 });

describe("generateCamp — the synthetic sample camp (decision 92)", () => {
  test("is deterministic for a seed", () => {
    expect(generateCamp({ seed: 2026, year: 2026 })).toEqual(camp);
    expect(generateCamp({ seed: 7, year: 2026 })).not.toEqual(camp);
  });

  test("has a camp's size", () => {
    expect(camp.campers).toHaveLength(SAMPLE_KIDS);
    expect(camp.staff).toHaveLength(SAMPLE_STAFF);
    expect(camp.teams.length).toBeGreaterThan(4);
    expect(camp.rooms.length).toBeGreaterThan(20);
  });

  test("every person name ends (exemplo)", () => {
    for (const n of [...camp.campers.flatMap((k) => [k.name, k.guardianName]), ...camp.staff.map((s) => s.name)]) expect(n).toEndWith(" (exemplo)");
    for (const k of camp.campers) if (k.invitedBy) expect(k.invitedBy).toEndWith(" (exemplo)");
  });

  test("phones are only the fixture range, emails only @example.test, no CPF / RG", () => {
    for (const p of [...camp.campers.map((k) => k.guardianPhone), ...camp.staff.map((s) => s.phone)]) expect(p).toMatch(PHONE);
    for (const k of camp.campers) {
      expect(k.emergencyContact).toMatch(/ \+55 11 90000-00\d{2}$/);
      if (k.guardianEmail) expect(k.guardianEmail).toEndWith("@example.test");
      expect([k.cpf, k.rg, k.guardianCpf]).toEqual(["", "", ""]);
    }
    // nothing that looks like a phone, CPF or email outside the fixture shapes, anywhere
    for (const s of strings(camp)) {
      expect(s).not.toMatch(/\b\d{3}\.?\d{3}\.?\d{3}-\d{2}\b/);
      for (const phone of s.match(/\+?\d[\d\s().-]{8,}\d/g) ?? []) if (!/^\d{4}-\d{2}-\d{2}$/.test(phone)) expect(phone).toMatch(PHONE);
      for (const email of s.match(/\S+@\S+/g) ?? []) expect(email).toEndWith("@example.test");
    }
  });

  test("one phone is one adult (core finds adults by phone)", () => {
    const byPhone = new Map<string, string>();
    for (const [phone, name] of [...camp.staff.map((s) => [s.phone, s.name]), ...camp.campers.map((k) => [k.guardianPhone, k.guardianName])] as [string, string][]) {
      expect(byPhone.get(phone) ?? name).toBe(name);
      byPhone.set(phone, name);
    }
  });

  test("schools, churches and health texts are invented", () => {
    for (const k of camp.campers) {
      if (k.school) expect(k.school).toStartWith("Escola Exemplo ");
      if (k.church) expect(k.church).toContain("Exemplo");
      if (k.insurance) expect(k.insurance).toContain("Exemplo");
      for (const t of [...k.allergies, ...k.healthIssues, k.foodRestrictions, k.healthNotes, k.generalNotes]) if (t) expect(t).toContain("(exemplo)");
    }
    for (const s of camp.staff) if (s.healthNotes) expect(s.healthNotes).toContain("(exemplo)");
  });

  test("no text of the old real-data file survives", () => {
    for (const s of strings(camp)) expect(OLD_SAMPLE_HASHES.has(hash(s))).toBe(false);
  });

  test("kids are Jardim II to 5º ano and every reference resolves, within room capacity", () => {
    const teams = new Set(camp.teams.map((t) => t.name));
    const transports = new Set(camp.transports.map((t) => (t.kind === "bus" ? `bus:${t.number}` : "car")));
    const rooms = new Map(camp.rooms.map((r) => [`${r.group}:${r.name}`, r.bunkBeds * 2 + r.singleBeds]));
    const used = new Map<string, number>();
    for (const p of [...camp.campers, ...camp.staff]) {
      if (p.team) expect(teams.has(p.team)).toBe(true);
      if (p.transportation) expect(transports.has(p.transportation)).toBe(true);
      if (p.room) {
        const key = `${p.roomGroup}:${p.room}`;
        expect(rooms.has(key)).toBe(true);
        used.set(key, (used.get(key) ?? 0) + 1);
      }
    }
    for (const [key, n] of used) expect(n).toBeLessThanOrEqual(rooms.get(key)!);
    for (const k of camp.campers) {
      const age = 2026 - Number(k.birthDate!.slice(0, 4));
      expect(age).toBeGreaterThanOrEqual(5);
      expect(age).toBeLessThanOrEqual(11);
      expect(["Jardim II", "1º ano", "2º ano", "3º ano", "4º ano", "5º ano"]).toContain(k.schoolGrade);
      if (k.room) expect(k.roomGroup).toBe(k.sex === "F" ? "girls" : "boys");
    }
  });
});
