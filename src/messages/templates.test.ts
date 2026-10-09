import { describe, expect, test } from "bun:test";
import { TEMPLATE_DEFAULTS, TEMPLATE_SLUGS, placeholders, validateTemplate } from "./templates";

describe("message template catalog", () => {
  test("every default passes core's rules (slug, pt-BR, known {vars}, SMS ≤ 160) in all 5 languages", () => {
    for (const t of TEMPLATE_DEFAULTS) {
      expect(validateTemplate(t)).toBeNull();
      expect(Object.keys(t.body).sort()).toEqual(["de", "en-US", "es", "fr", "pt-BR"]);
    }
  });

  test("decision 45: every SMS fits 160 characters in every language with realistic values", () => {
    const sample: Record<string, string> = { name: "Mariana", aboutName: "Joãozinho", birthdayNames: "Ana Clara, João & Maria", kid: "Joãozinho", kids: "Ana & João", room: "Quarto 12", link: "https://acampa.ipalpha.org", event: "Gincana (12/09 14:00)", when: "Gincana (13/09 15:00)", duty: "Base 3 · Time Belém", title: "Regras do acampamento", team: "Time Belém", bus: "Ônibus Azul 2", staff: "Mariana", count: "12", code: "123456", minutes: "5", failed: "3", total: "40" };
    for (const t of TEMPLATE_DEFAULTS.filter((x) => x.channel === "sms")) {
      for (const [lang, text] of Object.entries(t.body)) {
        const rendered = text.replace(/\{(\w+)\}/g, (_, k: string) => sample[k] ?? k);
        if (rendered.length > 160) throw new Error(`${t.slug} ${lang}: ${rendered.length} chars`);
      }
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
