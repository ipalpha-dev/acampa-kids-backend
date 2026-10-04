import { describe, expect, test } from "bun:test";
import { LOCALES, resolveLocale } from "./locales";
import { CATALOGS, sms, type SmsKey } from "./sms";

const placeholders = (text: string) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();

/** keys that are legitimately blank in some languages (no article / no "of" particle) */
const MAY_BE_EMPTY = new Set<SmsKey>(["ofHer", "ofHim", "theF", "theM"]);

describe("locales", () => {
  test("the backend speaks the same five languages as the frontend", () => {
    expect([...LOCALES]).toEqual(["pt", "en", "es", "fr", "de"]);
  });

  test("device tags resolve to German", () => {
    expect(resolveLocale("de-DE")).toBe("de");
    expect(resolveLocale("de")).toBe("de");
    expect(resolveLocale("de_AT")).toBe("de");
    expect(resolveLocale("DE-CH")).toBe("de");
  });

  test("unknown tags still fall back to Portuguese", () => {
    expect(resolveLocale("it-IT")).toBe("pt");
    expect(resolveLocale(null)).toBe("pt");
  });
});

describe("SMS catalogs", () => {
  const keys = Object.keys(CATALOGS.pt) as SmsKey[];

  test("every locale has a catalog", () => {
    for (const locale of LOCALES) expect(CATALOGS[locale]).toBeDefined();
  });

  for (const locale of LOCALES) {
    test(`${locale}: same keys as pt, no blank texts`, () => {
      const catalog = CATALOGS[locale] as Record<string, unknown>;
      expect(Object.keys(catalog).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        expect(typeof catalog[key]).toBe("string");
        if (!MAY_BE_EMPTY.has(key)) expect((catalog[key] as string).length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    });
  }

  test("de: every key keeps exactly the pt placeholders", () => {
    for (const key of keys) {
      expect(placeholders(CATALOGS.de[key]), `de.${key}`).toEqual(placeholders(CATALOGS.pt[key]));
    }
  });

  test("de texts are actually used (no silent pt fallback)", () => {
    expect(sms("de", "otp", { prefix: "Acampa", code: "123456", minutes: 10 })).toContain("Zugangscode");
    expect(sms("de", "kidGainedRoom", { kid: "Ana", room: "103", n: 2, s: sms("de", "kidPluralSuffix") })).toContain("2 Kinder bei dir");
  });
});
