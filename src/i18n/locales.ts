/** Languages the app speaks. Default is Portuguese (the camp's home language). */
export const LOCALES = ["pt", "en", "es", "fr", "de"] as const;
export type Locale = (typeof LOCALES)[number];

/** Default / fallback language — Brazilian Portuguese. */
export const DEFAULT_LOCALE: Locale = "pt";

/** Map a device / Accept-Language tag onto one of our five locales. */
export function resolveLocale(raw: string | null | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE;
  const tag = raw.trim().toLowerCase().replace("_", "-");
  const primary = tag.split("-")[0] ?? tag;
  if ((LOCALES as readonly string[]).includes(primary)) return primary as Locale;
  return DEFAULT_LOCALE;
}

/** Tiny `{name}` / `{count}` interpolator. Missing keys stay as `{key}`. */
export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => (vars[key] !== undefined ? String(vars[key]) : `{${key}}`));
}
