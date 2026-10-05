import { describe, expect, test } from "bun:test";
import { TEMPLATE_DEFAULTS, TEMPLATE_SLUGS, placeholders, validateTemplate } from "./templates";

describe("message template catalog", () => {
  test("every default passes core's rules (slug, pt-BR, known {vars}, SMS ≤ 320) in all 5 languages", () => {
    for (const t of TEMPLATE_DEFAULTS) {
      expect(validateTemplate(t)).toBeNull();
      expect(Object.keys(t.body).sort()).toEqual(["de", "en-US", "es", "fr", "pt-BR"]);
    }
  });

  test("every declared variable is used in the pt-BR copy", () => {
    for (const t of TEMPLATE_DEFAULTS) expect(placeholders(t.body["pt-BR"] + (t.subject?.["pt-BR"] ?? "")).sort()).toEqual([...t.variables].sort());
  });

  test("every catalog key has a default and slugs are unique", () => {
    const slugs = TEMPLATE_DEFAULTS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of Object.values(TEMPLATE_SLUGS)) expect(slugs).toContain(slug);
  });

  test("pastoral copy: no blunt labels in any language", () => {
    const text = JSON.stringify(TEMPLATE_DEFAULTS).toLowerCase();
    for (const word of ["padrasto", "madrasta", "enteado", "óbito", "inadimplente", "carente", "divorciad"]) expect(text).not.toContain(word);
  });

  test("an unknown variable is refused", () => {
    expect(validateTemplate({ slug: "acampa-x", channel: "sms", body: { "pt-BR": "Oi {name} {cpf}" } as never, variables: ["name"] })).toContain("cpf");
  });
});
