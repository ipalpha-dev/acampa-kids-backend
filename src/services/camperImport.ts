import * as XLSX from "xlsx";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import { findBedroomByName, insertBedroom, listBedrooms, updateBedroom } from "../models/bedrooms";
import { EMPTY_CAMPER, findCamperById, insertCamper, listCampers, updateCamper, type CamperData } from "../models/campers";
import { appendCategoryOption, listCategories, newOptionId } from "../models/categories";
import { EMPTY_STAFF, insertStaff, listStaff } from "../models/staff";
import { insertTeam, listTeams, TEAM_PALETTE } from "../models/teams";
import { insertTransport, listTransports, nextTransportOrder } from "../models/transports";
import { busColorName, BUS_COLORS, CAMPER_CATEGORY_KEYS, bedroomCapacity, EMPTY_HEALTH, TEAM_ROLE, type BedroomGroup, type CamperImportDictionaryEntry, type CamperImportReviewItem, type CamperSex, type Category, type HealthInfo, type Staff } from "../types";
import { formatBrazilPhone, formatCpf, normalizeBrazilPhone, titleCaseName } from "../utils";
import { transportLabel } from "../routes/transports";
import { bestImportMatch, bestImportMatches, classifyImportItems, dedupeImportValues, mapImportColumns, matchLeaderWithAi, askDateParser, SPLIT_CATEGORY_FIELDS } from "./importAi";
import { getDb } from "../db";
import { listImportDictionary, type CamperImportColumn, type CamperImportCreatedItem } from "../models/camperImports";
import { namesOf } from "./people";
import { IpalphaRejected } from "./ipalpha/coreClient";
import { addResponsible, documentsOf, emergencyContactOf, healthToCore, registerAdult, registerKid, type CoordinationTokens } from "./coreRegistration";
import { mergeHealth, readHealth, writeHealth } from "./people";

/** A team member with the name read live from core (imports match leaders by name). */
export type NamedStaff = Staff & { name: string };

/** The current camp's team, with names (one paged names read). */
export async function namedStaff(filter: Parameters<typeof listStaff>[0] = { active: true }): Promise<NamedStaff[]> {
  const list = await listStaff(filter);
  const names = await namesOf(list.map((s) => s._id));
  return list.map((s) => ({ ...s, name: names.get(s._id)?.name ?? "" }));
}

/** What an import apply needs to create people in core. */
export interface ImportCoreContext {
  tokens: CoordinationTokens;
  editionId: string;
}

export const IMPORT_FILE_MAX_BYTES = 12 * 1024 * 1024;
export const IMPORT_ROWS_MAX = 5_000;

export const IMPORT_FIELDS = [
  { key: "name", label: "Nome da criança", aliases: ["nome", "nome completo", "acampante", "criança"], required: true },
  { key: "birthDate", label: "Data de nascimento", aliases: ["nascimento", "data nascimento", "data de nascimento"], required: true },
  { key: "probableGender", label: "Sexo", aliases: ["sexo", "sexo m ou f", "sexo da criança", "genero", "gênero"] },
  { key: "bed", label: "Posição da cama", aliases: ["cama", "beliche", "posição cama", "bed position"] },
  { key: "bedroomPreference", label: "Preferência de quarto", aliases: ["quer ficar com", "dividir quarto", "preferência quarto", "gostaria de ficar no mesmo quarto de alguém"] },
  { key: "team", label: "Time", aliases: ["equipe", "team", "cor" ] },
  { key: "transportation", label: "Transporte", aliases: ["ônibus", "onibus", "bus", "veículo", "veiculo"] },
  { key: "bedroom", label: "Quarto", aliases: ["dormitório", "dormitorio", "room", "alojamento"] },
  { key: "leader", label: "Líder", aliases: ["lider", "líder", "tio", "tia", "monitor", "responsável quarto"] },
  { key: "cpf", label: "CPF da criança", aliases: ["cpf", "cpf acampante", "cpf criança"] },
  { key: "guardianCpf", label: "CPF do responsável", aliases: ["cpf responsavel", "cpf responsável", "cpf pai", "cpf mãe"] },
  { key: "rg", label: "RG", aliases: ["identidade"] },
  { key: "school", label: "Escola", aliases: ["colégio", "colegio"] },
  { key: "schoolGrade", label: "Série", aliases: ["serie", "ano escolar", "série escolar", "série/ano escolar", "turma"] },
  { key: "church", label: "Frequenta igreja", aliases: ["igreja", "igreja que frequenta", "congregação", "congregacao"] },
  { key: "invitedBy", label: "Convidado por", aliases: ["quem convidou", "indicação", "indicacao"] },
  { key: "guardianName", label: "Nome do responsável", aliases: ["responsável", "responsavel", "nome pai", "nome mãe", "nome mae"] },
  { key: "guardianPhone", label: "Telefone do responsável", aliases: ["telefone", "celular", "whatsapp", "fone responsável"] },
  { key: "guardianEmail", label: "E-mail", aliases: ["email", "e-mail responsável", "e-mail do responsável", "email do responsável"] },
  { key: "emergencyContact", label: "Contato de emergência", aliases: ["emergência", "emergencia", "contato emergencia", "contato de emergência nome e telefone"] },
  { key: "insurance", label: "Convênio médico", aliases: ["convenio", "plano de saúde", "plano saude"] },
  { key: "insuranceCard", label: "Carteirinha", aliases: ["número carteirinha", "numero carteirinha", "número da carteirinha", "numero da carteirinha", "carteirinha do convênio", "carteirinha do convenio"] },
  { key: "weightKg", label: "Peso", aliases: ["peso kg", "peso aproximado kg", "weight"] },
  { key: "allergies", label: "Alergias", aliases: ["alergia", "a criança tem alguma alergia", "a crianca tem alguma alergia"] },
  { key: "drugAllergies", label: "Alergia a medicamentos", aliases: ["alergia medicamento", "alergia a medicamento", "alergia a remédio", "medicine allergies"] },
  { key: "healthIssues", label: "Condições de saúde", aliases: ["condição crônica", "condicoes cronicas", "doenças crônicas", "problemas de saúde"] },
  { key: "neurodivergent", label: "Neurodivergente", aliases: ["neurodivergência", "neurodivergencia", "tea", "tdah", "autismo"] },
  { key: "dailyMedication", label: "Medicação de uso diário", aliases: ["medicacao uso diario", "medicamentos de uso diário", "medicamentos de uso diario", "remédio diário", "remedio diario"] },
  { key: "foodRestrictions", label: "Restrição alimentar", aliases: ["restrições alimentares", "restricoes alimentares", "restrição de alimentação", "alimentação", "alimentacao", "food restriction"] },
  { key: "healthNotes", label: "Observações médicas", aliases: ["observacao medica", "observações de saúde", "observacoes de saude", "saúde", "saude"] },
  { key: "generalNotes", label: "Observações", aliases: ["outras observações", "observacoes gerais", "notas"] },
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number]["key"];

export interface ImportAnalysis {
  columns: CamperImportColumn[];
  rows: Record<string, string>[];
  dictionaries: CamperImportDictionaryEntry[];
  reviews: CamperImportReviewItem[];
  preview: Record<string, unknown>[];
  skipped: Record<string, unknown>[];
  createdItems: CamperImportCreatedItem[];
  dateFunction: string;
  status: "needs_mapping" | "panic" | "review" | "ready";
  panicMessage: string;
}

export interface ImportLookups {
  bedrooms: Awaited<ReturnType<typeof listBedrooms>>;
  transports: Awaited<ReturnType<typeof listTransports>>;
  teams: Awaited<ReturnType<typeof listTeams>>;
  categories: Awaited<ReturnType<typeof listCategories>>;
  staff: NamedStaff[];
}

export const normalizeImportValue = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim();
/** Full names identify by name alone; a single name needs the birth date. */
export function camperIdentityKey(name:string,birthDate:string|null|undefined):string|null{const normalized=normalizeImportValue(name),parts=normalized.split(" ").filter(Boolean);if(!normalized)return null;if(parts.length>1)return `name:${normalized}`;return birthDate?`name-birth:${normalized}:${birthDate}`:null;}
const normalize = normalizeImportValue;
const compact = (value: string): string => normalize(value).replace(/\s/g, "");
/** Spreadsheet UUID / ObjectId leftover, e.g. `89c85104-0d73-4ebf-821c-08f94689254e`. */
export const IMPORT_ID_VALUE_RE = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{24})$/i;
const IMPORT_ID_HEADER_RE = /^(?:id|uuid|guid|_id|[a-z0-9]+_id|[a-z0-9]+ id)$/;
const CAMPER_EXTRA_COLUMNS = ["created at", "criado em", "qr token", "qr_token", "guardian id", "guardian_id"];
/** Foreign-key / technical columns that must never become Nome, Quarto, Transporte, or notes. */
export function isIgnoredImportColumn(header: string): boolean {
  const n = normalize(header);
  if (!n) return false;
  if (IMPORT_ID_HEADER_RE.test(n)) return true;
  return CAMPER_EXTRA_COLUMNS.some((extra) => n === extra || n.startsWith(`${extra} `));
}
const text = (v: unknown): string => v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();

export function isEmptyCategoryValue(value: string): boolean {  const n = normalize(value);
  if (!n || [
    "n", "na", "nao", "nada", "nenhum", "nenhuma", "nenhuns", "nenhumas",
    "nao tenho", "nao tem", "nao possui", "nao possuo", "sem", "inexistente",
    "sem alergia", "sem alergias", "nenhuma alergia", "nenhuma alergias",
    "sem restricao", "sem restricoes", "sem doenca", "sem doencas",
  ].includes(n)) return true;
  return /^(?:nao (?:tenho|tem|possui|possuo)|sem|nenhum(?:a)?) (?:alergia(?:s)?|problema(?:s)? de saude|condicao|condicoes|doenca|doencas|restricao|restricoes)$/.test(n);
}

/** An option label longer than this is a narrative, not a condition name. */
export const CATEGORY_OPTION_MAX = 48;

/** "picadas" → "picada", "leveduras" → "levedura": plural forms must not become separate options */
function singularize(word: string): string {
  const w = word.toLocaleLowerCase("pt-BR");
  if (w.length <= 3) return w;
  if (w.endsWith("ões")) return `${w.slice(0, -3)}ão`;
  if (w.endsWith("ais") || w.endsWith("éis") || w.endsWith("óis") || w.endsWith("uis")) return `${w.slice(0, -2)}l`;
  if (w.endsWith("ns")) return `${w.slice(0, -2)}m`;
  if (w.endsWith("res") || w.endsWith("zes") || w.endsWith("ses")) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

const CATEGORY_STOPWORDS = new Set(["a", "o", "as", "os", "um", "uma", "de", "do", "da", "dos", "das", "ao", "aos", "e", "com", "em", "no", "na", "alergia", "alergias", "alergico", "alergica"]);

/**
 * Matching key of a category atom without the model: drops articles,
 * "alergia a", parentheticals and plurals, so "Picadas Insetos", "Picada de
 * inseto" and "A Poeira" collapse onto one option. Never used as a label.
 */
export function categoryAtomKey(raw: string): string {
  const withoutNotes = raw.replace(/\([^)]*\)/g, " ");
  const words = normalize(withoutNotes).split(" ").filter(Boolean);
  while (words.length > 1 && CATEGORY_STOPWORDS.has(words[0]!)) words.shift();
  const kept = words.filter((w, i) => i === 0 || !CATEGORY_STOPWORDS.has(w));
  return (kept.length ? kept : words).map(singularize).join(" ");
}

/** Readable label for an atom: the original words minus articles / "alergia a", kept in the singular. */
export function canonicalCategoryAtom(raw: string): string {
  const withoutNotes = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const words = withoutNotes.split(" ").filter(Boolean);
  while (words.length > 1 && CATEGORY_STOPWORDS.has(normalize(words[0]!))) words.shift();
  // only the head word carries the plural: "Picadas de inseto" → "Picada de inseto"
  if (words.length) words[0] = singularizeKeepingCase(words[0]!);
  if (words.length > 1) words[words.length - 1] = singularizeKeepingCase(words[words.length - 1]!);
  return titleCaseName(words.join(" "));
}

/** "Picadas" → "Picada" keeping the original accents/case for display */
function singularizeKeepingCase(word: string): string {
  const lower = word.toLocaleLowerCase("pt-BR");
  const singular = singularize(lower);
  return singular.length === lower.length ? word : word.slice(0, word.length - (lower.length - singular.length));
}

/**
 * A health cell is a narrative when it reads as a sentence, not a label:
 * prophylaxis instructions, clinical histories, dosage notes. Narratives are
 * never category options in any health field (allergies, drugAllergies,
 * healthIssues) — they stay in the notes for the background review to sort.
 */
export function isNarrativeCategoryText(raw: string): boolean {
  return raw.length > 120 || raw.split(/\s+/).length > 14;
}

/**
 * Atoms that occur ONLY in narrative cells: they must never be matched to or
 * create a category option. Takes [raw cell, its atoms] pairs so an atom that
 * also appears in a short label cell (a genuine allergy) still resolves.
 */
export function narrativeOnlyAtoms(pairs: [raw: string, atoms: string[]][]): Set<string> {
  const sources = new Map<string, Set<string>>();
  for (const [raw, atoms] of pairs) {
    for (const atom of atoms) {
      const set = sources.get(atom) ?? new Set<string>();
      set.add(raw);
      sources.set(atom, set);
    }
  }
  return new Set([...sources].filter(([, raws]) => [...raws].every(isNarrativeCategoryText)).map(([atom]) => atom));
}

/**
 * Deterministic fallback split for a health cell, used when the model skipped
 * the value: a monster sentence must never become a single category option.
 */
export function splitCategoryText(raw: string): string[] {
  // a narrative cell ("Apresenta episódios raros de terror noturno, que devem
  // ser tratados com...") is a note: it must not spawn options at all
  if (isNarrativeCategoryText(raw)) return [];
  const byKey = new Map<string, string>();
  for (const part of raw.split(/[,;/\n]|\se\s|\s[-–—]\s|\+/gi)) {
    const label = canonicalCategoryAtom(part.replace(/^[\s.\-–—*:]+|[\s.\-–—*:]+$/g, ""));
    if (label.length <= 1 || label.length > CATEGORY_OPTION_MAX) continue;
    const key = categoryAtomKey(label);
    if (key && !byKey.has(key)) byKey.set(key, label);
  }
  return [...byKey.values()].slice(0, 6);
}

function phraseContained(longer: string, shorter: string): boolean {
  return ` ${longer} `.includes(` ${shorter} `);
}

export function directImportField(header: string): { key: ImportField; confidence: number } | null {
  const h = normalize(header);
  let best: { key: ImportField; confidence: number; specificity: number } | null = null;
  let bestConfidence = 0;
  let bestSpecificity = 0;
  for (const field of IMPORT_FIELDS) {
    for (const alias of [field.label, ...field.aliases]) {
      const a = normalize(alias);
      const specificity = a.split(" ").filter(Boolean).length * 100 + a.length;
      const confidence = h === a ? 1
        : compact(h) === compact(a) ? .97
          : phraseContained(h, a) && a.split(" ").length >= 2 ? .86
            : phraseContained(a, h) && h.split(" ").length >= 2 ? .83
              : 0;
      if (confidence > bestConfidence || (confidence === bestConfidence && specificity > bestSpecificity)) {
        best = { key: field.key, confidence, specificity };
        bestConfidence = confidence;
        bestSpecificity = specificity;
      }
    }
  }
  return best && best.confidence >= .82 ? { key: best.key, confidence: best.confidence } : null;
}

const directField = directImportField;

export function parseSpreadsheet(data: Uint8Array, fileName: string): { rows: Record<string, string>[]; columns: { name: string; samples: string[] }[] } {
  // SheetJS otherwise treats headerless CSV bytes as a legacy code page on
  // some inputs, turning "saúde" into "saÃºde" before column matching.
  const textFile = /\.(?:csv|tsv|txt)$/i.test(fileName);
  const workbook = textFile
    ? XLSX.read(new TextDecoder("utf-8").decode(data).replace(/^\uFEFF/, ""), { type: "string", cellDates: false, raw: true, codepage: 65001 })
    : XLSX.read(data, { type: "array", cellDates: true, codepage: 65001 });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) throw new Error("A planilha não tem abas legíveis.");
  // CSV values must remain literal strings: formatting them makes SheetJS
  // turn 2016-12-15 into 12/14/16 in the local timezone. Excel cells still
  // use their displayed value so formatted dates remain human-readable.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: textFile, blankrows: false });
  if (matrix.length < 2) throw new Error("A planilha precisa ter cabeçalho e ao menos uma criança.");
  const rawHeaders = (matrix[0] ?? []).map(text);
  const headers: string[] = [];
  const used = new Map<string, number>();
  rawHeaders.forEach((raw, i) => {
    const base = raw || `Coluna ${i + 1}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    headers.push(n === 1 ? base : `${base} (${n})`);
  });
  const rows = matrix.slice(1, IMPORT_ROWS_MAX + 1).map((line) => Object.fromEntries(headers.map((h, i) => [h, text(line?.[i])]))).filter((row) => Object.values(row).some(Boolean));
  if (rows.length === 0) throw new Error(`Nenhum registro foi encontrado em ${fileName}.`);
  const columns = headers.map((name) => ({ name, samples: rows.map((r) => r[name]).filter(Boolean).slice(0, 5) }));
  return { rows, columns };
}

export async function mapColumns(columns: { name: string; samples: string[] }[], override: Record<string, string | null> = {}, signal?: AbortSignal): Promise<CamperImportColumn[]> {
  const saved = new Map((await listImportDictionary()).filter((d) => d.kind === "column" && d.field.startsWith("column:")).map((d) => [d.normalized, typeof d.value === "string" ? d.value : null]));
  const unresolved = columns.filter((c) => override[c.name] === undefined && !isIgnoredImportColumn(c.name) && !directField(c.name) && !saved.has(normalize(c.name)));
  const ai = unresolved.length ? await mapImportColumns(unresolved, IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label, aliases: [...f.aliases], required: "required" in f && f.required })), signal) : {};
  const used = new Set<string>();
  return columns.map((c) => {
    const ignored = isIgnoredImportColumn(c.name);
    const direct = directField(c.name);
    const requested = ignored ? null : override[c.name] !== undefined ? override[c.name] : direct?.key ?? saved.get(normalize(c.name)) ?? ai[c.name]?.target ?? null;
    const target = requested && IMPORT_FIELDS.some((f) => f.key === requested) && !used.has(requested) ? requested : null;
    if (target) used.add(target);
    return { source: c.name, target, confidence: ignored ? 1 : override[c.name] !== undefined ? 1 : direct?.confidence ?? ai[c.name]?.confidence ?? 0, samples: c.samples };
  });
}

export function sourceMap(columns: CamperImportColumn[]): Map<string, string> {
  return new Map(columns.filter((c): c is CamperImportColumn & { target: string } => !!c.target).map((c) => [c.target, c.source]));
}

export function valueOf(row: Record<string, string>, sources: Map<string, string>, field: string): string {
  const source = sources.get(field);
  return source ? row[source]?.trim() ?? "" : "";
}

function validCpf(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return "";
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]) ? formatCpf(d) : "";
}

export function validEmail(raw: string): string {
  const value = raw.trim().toLowerCase();
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

export function importPhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 9) d = `11${d}`;
  return normalizeBrazilPhone(d);
}

export function parseWeight(raw: string): number | null {
  const match = raw.replace(",", ".").match(/\d+(?:\.\d+)?/);
  const n = match ? Number(match[0]) : NaN;
  return Number.isFinite(n) && n >= 5 && n <= 200 ? Math.round(n * 10) / 10 : null;
}

/** Spreadsheet sex is accepted only from explicit, deterministic values. */
export function parseImportSex(raw: string): CamperSex | null {
  const value = normalize(raw);
  if (["f", "fem", "feminino", "feminina", "female", "mulher", "menina"].includes(value)) return "F";
  if (["m", "masc", "masculino", "masculina", "male", "homem", "menino"].includes(value)) return "M";
  return null;
}

/**
 * Formats every unambiguous Brazilian mobile number inside a free-text
 * emergency contact while preserving names and relationship notes.
 * Ambiguous/invalid digit runs stay untouched rather than being guessed.
 */
export function normalizeEmergencyContact(raw: string): string {
  const phoneLike = /(?:\+?55[\s().-]*)?(?<!\d)\d{2}[\s().-]*\d{4,5}[\s.-]*\d{4}(?!\d)|(?<!\d)\d{4,5}[\s.-]*\d{4}(?!\d)/g;
  const formatted = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(phoneLike, (candidate) => {
      const phone = importPhone(candidate);
      return phone ? formatBrazilPhone(phone) : candidate.trim();
    })
    .replace(/\s*\/\s*/g, " · ")
    .replace(/\s+-\s+(?=\(?\d)/g, " · ")
    .replace(/([\p{L})])\s+(?=\(\d{2}\)\s\d{4,5}-\d{4})/gu, "$1 · ")
    .replace(/(\d{4})\s+(?=[\p{L}])/gu, "$1 · ")
    .replace(/\s*·\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  return formatted;
}

function daysInMonth(year: number, month: number): number { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > new Date().getFullYear() || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function ageOfIso(value: string | null): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age--;
  return Math.max(0, age);
}

export const BUILTIN_DATE_FUNCTION = `function parseImportDate(value) {
  const s = String(value ?? "").trim(); if (!s) return null;
  let m = /^(\\d{1,2})[\\/-](\\d{1,2})[\\/-](\\d{4})$/.exec(s); if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = /^(\\d{4})[\\/-](\\d{1,2})[\\/-](\\d{1,2})$/.exec(s); if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\\d{1,2})[\\/-](\\d{1,2})[\\/-](\\d{2})$/.exec(s); if (m) return isoDate(2000 + +m[3], +m[2], +m[1]);
  if (/^\\d+(?:\\.\\d+)?$/.test(s)) { const serial = Number(s); const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000); return isoDate(date.getUTCFullYear(), date.getUTCMonth()+1, date.getUTCDate()); }
  return null;
}`;

export function parseBuiltInDate(value: string): string | null {
  const s = value.trim();
  let m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(s);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})$/.exec(s);
  if (m) return isoDate(2000 + +m[3], +m[2], +m[1]);
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  return null;
}

const FORBIDDEN_DATE_SOURCE = /\b(?:eval|Function|constructor|prototype|__proto__|process|global|globalThis|require|import|fetch|XMLHttpRequest|WebSocket|Bun|Deno|WebAssembly|setTimeout|setInterval)\b/;
function parseAiDate(source: string, value: string): string | null {
  if (!source || source.length > 4_000 || FORBIDDEN_DATE_SOURCE.test(source)) return null;
  try {
    // Fable is asked for a function body, but tolerate a full declaration too.
    const declaredBody = /^\s*function\s+parseImportDate\s*\([^)]*\)\s*\{([\s\S]*)\}\s*;?\s*$/.exec(source)?.[1];
    const body = declaredBody ?? source;
    const script = new Script(`"use strict"; const value = ${JSON.stringify(value)}; const isoDate = (y,m,d) => { const dt = new Date(Date.UTC(y,m-1,d)); return dt.getUTCFullYear()===y && dt.getUTCMonth()+1===m && dt.getUTCDate()===d ? String(y).padStart(4,"0")+"-"+String(m).padStart(2,"0")+"-"+String(d).padStart(2,"0") : null; }; (() => { ${body} })()`);
    const out = script.runInNewContext({ Date }, { timeout: 25 });
    return typeof out === "string" && /^\d{4}-\d{2}-\d{2}$/.test(out) && !Number.isNaN(Date.parse(`${out}T00:00:00Z`)) ? out : null;
  } catch {
    return null;
  }
}

function review(kind: CamperImportReviewItem["kind"], row: number, kidName: string, original: string, extras: Partial<CamperImportReviewItem> = {}): CamperImportReviewItem {
  return { id: randomUUID(), row, kind, field: kind, kidName, guardianName: "", birthDate: "", age: null, emergencyContact: "", original, value: "", skip: false, resolved: false, ...extras };
}

export function deterministicLeader(raw: string, staff: NamedStaff[]): { id: string | null; options: NamedStaff[] } {
  const words = normalize(raw).split(" ").filter(Boolean);
  if (!words.length) return { id: null, options: [] };
  const scored = staff.map((s) => {
    const sw = normalize(s.name).split(" ").filter(Boolean);
    let score = compact(s.name) === compact(raw) ? 100 : 0;
    if (words.length === 1 && sw[0] === words[0]) score = Math.max(score, 80);
    if (words.length >= 2 && sw[0] === words[0] && sw.at(-1) === words.at(-1)) score = Math.max(score, 95);
    if (words.length >= 2 && sw[0] === words[0] && sw[1] === words[1]) score = Math.max(score, 90);
    if (sw[0] === words[0] && words.some((w) => sw.includes(w))) score = Math.max(score, 75);
    return { staff: s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { id: null, options: [] };
  const top = scored[0].score;
  const options = scored.filter((x) => x.score === top).map((x) => x.staff);
  return { id: options.length === 1 && top >= 80 ? options[0]._id : null, options };
}

export function extractImportNumber(raw: string): string | null {
  const found = raw.match(/\d+/)?.[0];
  return found ? String(Number(found)) : null;
}
const numberFrom = extractImportNumber;

function deterministicMatch(raw: string, candidates: { id: string; label: string }[]): string | null {
  const n = normalize(raw);
  const exact = candidates.find((c) => normalize(c.label) === n || compact(c.label) === compact(raw));
  if (exact) return exact.id;
  // "Picadas Insetos" and "Picada de inseto" are the same option
  const canonical = categoryAtomKey(raw);
  const sameCanonical = candidates.find((c) => categoryAtomKey(c.label) === canonical);
  if (sameCanonical) return sameCanonical.id;
  const number = numberFrom(raw);
  if (number) {
    const numbered = candidates.filter((c) => numberFrom(c.label) === number);
    if (numbered.length === 1) return numbered[0].id;
  }
  const contained = candidates.filter((c) => normalize(c.label).includes(n) || n.includes(normalize(c.label)));
  return contained.length === 1 ? contained[0].id : null;
}

async function addCategoryOption(cat: Category, label: string, importId: string): Promise<string> {
  const option = { id: newOptionId(), label: label.trim().slice(0, 80), order: cat.options.length, active: true, draft: true, importId };
  if (!(await appendCategoryOption(cat._id, option))) throw new Error(`Não foi possível criar a opção ${option.label}.`);
  cat.options.push(option);
  return option.id;
}

export async function resolveCategoryValue(field: "bed" | "allergies" | "drugAllergies" | "healthIssues", canonical: string, lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<string | null> {
  const key = CAMPER_CATEGORY_KEYS[field];
  const cat = lookups.categories.find((c) => c.key === key);
  if (!cat || !canonical) return null;
  const candidates = cat.options.map((o) => ({ id: o.id, label: o.label }));
  if (canonical.length > CATEGORY_OPTION_MAX) return null;
  let id = deterministicMatch(canonical, candidates);
  if (!id) {
    const ai = await bestImportMatch(`opção da categoria ${cat.name}`, canonical, candidates, signal);
    id = ai.id;
    if (!id) {
      const name = titleCaseName(ai.createName || canonical);
      id = await addCategoryOption(cat, name, importId);
      createdItems.push({ kind: "categoryOption", id, label: `${cat.name}: ${name}`, draft: true });
    }
  }
  return id;
}

export async function resolveCategoryValues(field: "bed" | "allergies" | "drugAllergies" | "healthIssues", canonicals: string[], lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const key = CAMPER_CATEGORY_KEYS[field];
  const cat = lookups.categories.find((c) => c.key === key);
  if (!cat) return result;
  const candidates = cat.options.map((o) => ({ id: o.id, label: o.label }));
  const unresolved: string[] = [];
  const seen = new Map<string, string>();
  const twins: [string, string][] = [];
  for (const canonical of canonicals) {
    if (field !== "bed" && isEmptyCategoryValue(canonical)) { result.set(canonical, null); continue; }
    // a long sentence is a note, never an option — it stays in the health notes
    if (canonical.length > CATEGORY_OPTION_MAX) { result.set(canonical, null); continue; }
    // two atoms of this same batch that differ only by plural/article share one option
    const key = field === "bed" ? normalize(canonical) : categoryAtomKey(canonical);
    const twin = seen.get(key);
    if (twin !== undefined) { twins.push([canonical, twin]); continue; }
    seen.set(key, canonical);
    const id = deterministicMatch(canonical, candidates);
    if (id) result.set(canonical, id); else unresolved.push(canonical);
  }
  const matches = await bestImportMatches(`opção da categoria ${cat.name}`, unresolved, candidates, signal);
  for (const canonical of unresolved) {
    const match = matches[canonical];
    // only the generative fallback can answer "not an item at all" (id+createName null);
    // a Jev `none` comes back as createName=canonical and is created below
    if (match && !match.id && !match.createName) { result.set(canonical, null); continue; }
    let id = match?.id ?? deterministicMatch(match?.createName || canonical, cat.options.map((o) => ({ id: o.id, label: o.label })));
    if (!id) {
      const name = titleCaseName(match?.createName || canonical);
      id = await addCategoryOption(cat, name, importId);
      createdItems.push({ kind: "categoryOption", id, label: `${cat.name}: ${name}`, draft: true });
    }
    result.set(canonical, id);
  }
  for (const [canonical, twin] of twins) result.set(canonical, result.get(twin) ?? null);
  return result;
}

async function createTransportFor(raw: string, lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string): Promise<string> {
  const number = numberFrom(raw);
  const normalized = normalize(raw);
  const namedColor = BUS_COLORS.find((c) => normalized.includes(normalize(c.name))) ?? BUS_COLORS[lookups.transports.filter((t) => t.kind === "bus").length % BUS_COLORS.length];
  const transport = await insertTransport(number
    ? { kind: "bus", color: namedColor.hex, number, order: await nextTransportOrder(), draft: true, importId }
    : { kind: "car", name: titleCaseName(raw || "Carro"), order: await nextTransportOrder(), draft: true, importId });
  lookups.transports.push(transport);
  createdItems.push({ kind: "transportation", id: transport._id, label: transportLabel(transport), draft: true });
  return transport._id;
}

export async function resolveTransport(raw: string, lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<string | null> {
  if (!raw || IMPORT_ID_VALUE_RE.test(raw)) return null;
  const candidates = lookups.transports.map((t) => ({ id: t._id, label: transportLabel(t) }));
  let id = deterministicMatch(raw, candidates);
  if (!id) id = (await bestImportMatch("transporte (ônibus, van ou carro)", raw, candidates, signal)).id;
  return id ?? createTransportFor(raw, lookups, createdItems, importId);
}

export async function resolveTeam(raw: string, lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<string | null> {
  if (!raw || IMPORT_ID_VALUE_RE.test(raw)) return null;
  const candidates = lookups.teams.map((t) => ({ id: t._id, label: t.name }));
  let id = deterministicMatch(raw, candidates);
  let createName = raw;
  if (!id) {
    const ai = await bestImportMatch("time do acampamento", raw, candidates, signal);
    id = ai.id;
    createName = ai.createName || raw;
  }
  if (id) return id;
  const name = titleCaseName(createName);
  const team = await insertTeam({ name, color: TEAM_PALETTE[lookups.teams.length % TEAM_PALETTE.length], order: lookups.teams.length, draft: true, importId });
  lookups.teams.push(team);
  createdItems.push({ kind: "team", id: team._id, label: team.name, draft: true });
  return team._id;
}

export async function resolveBedroom(raw: string, names: string[], lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<string | null> {
  if (!raw || IMPORT_ID_VALUE_RE.test(raw)) return null;
  const candidates = lookups.bedrooms.map((b) => ({ id: b._id, label: b.name }));
  let id = deterministicMatch(raw, candidates);
  if (id) return id;
  const name = numberFrom(raw) || titleCaseName(raw).slice(0, 30);
  // the wing comes from the room's own name ("Meninas 3"); never guessed from the people's names (decision 39)
  void names;
  const inferred = normalize(raw).includes("menin") ? (normalize(raw).includes("menina") ? "girls" : "boys") : null;
  // Never silently put a mixed or ambiguous group in the boys' wing. Staff
  // import will ask for the room; campers may remain without one, as allowed.
  if (!inferred) return null;
  const group: BedroomGroup = inferred;
  const data = { name, group, bunkBeds: Math.max(1, Math.ceil(names.length / 2)), singleBeds: 0, notes: "Criado pelo importador; confirme a quantidade de camas.", draft: true, importId };
  // An abandoned dry-run may still own the unique room name. Adopt that
  // hidden draft so a corrected retry can finish instead of hitting E11000.
  const abandoned = await findBedroomByName(name);
  const room = abandoned?.draft ? (await updateBedroom(abandoned._id, data))! : await insertBedroom(data);
  lookups.bedrooms.push(room);
  createdItems.push({ kind: "bedroom", id: room._id, label: `${room.name} (${group})`, draft: true });
  return room._id;
}

export function concatOtherColumns(row: Record<string, string>, mappedSources: Set<string>, prefix = ""): string {
  return Object.entries(row).filter(([key, value]) => value && !mappedSources.has(key) && !isIgnoredImportColumn(key) && !IMPORT_ID_VALUE_RE.test(value)).map(([key, value]) => `${prefix}${key}: ${value}.`).join(" ");
}

export async function analyzeCamperImport(input: { data: Uint8Array; fileName: string; fileType: string; importId: string; mapping?: Record<string, string | null>; signal?: AbortSignal; onProgress?: (key: string, pct: number) => void }): Promise<ImportAnalysis> {
  const report = input.onProgress ?? (() => undefined);
  report("reading", 3);
  const parsed = parseSpreadsheet(input.data, input.fileName);
  report("reading", 8);
  report("columns", 10);
  const columns = await mapColumns(parsed.columns, input.mapping, input.signal);
  report("columns", 20);
  const sources = sourceMap(columns);
  const missing = IMPORT_FIELDS.filter((f) => "required" in f && f.required && !sources.has(f.key)).map((f) => f.key);
  // Only an unresolved identity column interrupts the flow. Everything else
  // is trusted to the automatic matching; unknown columns can still be
  // reassigned from the summary before applying.
  if (missing.length) return { columns, rows: parsed.rows, dictionaries: [], reviews: [], preview: [], skipped: [], createdItems: [], dateFunction: BUILTIN_DATE_FUNCTION, status: "needs_mapping", panicMessage: `Escolha as colunas de ${missing.map((k) => IMPORT_FIELDS.find((f) => f.key === k)?.label).join(" e ")}.` };

  const [bedrooms, transports, teams, rawCategories, staff, previousDictionary, campersNow] = await Promise.all([listBedrooms(), listTransports(), listTeams(), listCategories(), namedStaff({ active: true }), listImportDictionary(), listCampers()]);
  // this camp's kids with their names (live) — the duplicate check matches full names
  const camperNames = await namesOf(campersNow.map((k) => k._id));
  const existingCampers = campersNow.map((k) => ({ ...k, name: camperNames.get(k._id)?.name ?? "", birthDate: null as string | null }));
  // Draft entities belong to another unfinished import and must never leak
  // into this preview. Published dictionary values are still reused below.
  const categories = rawCategories.map((cat) => ({ ...cat, options: cat.options.filter((option) => !option.draft) }));
  const lookups: ImportLookups = { bedrooms, transports, teams, categories, staff };
  const createdItems: CamperImportCreatedItem[] = [];
  const dictionaries: CamperImportDictionaryEntry[] = [];
  const reviews: CamperImportReviewItem[] = [];
  const preview: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  const mappedSources = new Set(columns.filter((c) => c.target).map((c) => c.source));
  const groupedFields = ["bedroom", "leader", "transportation", "team", "neurodivergent", "bed", "allergies", "drugAllergies", "healthIssues"] as const;
  const grouped = Object.fromEntries(groupedFields.map((field) => [field, [...new Set(parsed.rows.map((row) => valueOf(row, sources, field)).filter(Boolean))]])) as Record<(typeof groupedFields)[number], string[]>;
  const existingDict = new Map(previousDictionary.map((d) => [`${d.field}:${d.normalized}`, d]));
  const isSplitField = (field: string) => (SPLIT_CATEGORY_FIELDS as readonly string[]).includes(field);
  report("dedupe", 24);
  const dedupedEntries = await Promise.all(groupedFields.map(async (field) => {
    const known: Record<string, string | boolean> = {};
    const unknown: string[] = [];
    for (const raw of grouped[field]) {
      const saved = existingDict.get(`${field}:${normalize(raw)}`);
      // split fields have no whole-cell answer anymore — their atoms are matched below
      if (saved && !isSplitField(field)) known[raw] = field === "neurodivergent" ? saved.value === true : saved.label || raw;
      else unknown.push(raw);
    }
    return [field, { ...known, ...(await dedupeImportValues(field, unknown, input.signal, isSplitField(field))) }] as const;
  }));
  const deduped = Object.fromEntries(dedupedEntries) as Record<string, Record<string, string | boolean | string[]>>;
  /** atomic canonical items of a raw cell value — split fields yield a list, others a single item */
  const atomsOf = (field: string, raw: string): string[] => {
    const d = deduped[field]?.[raw];
    // the model skipped this cell: split it deterministically instead of keeping the whole sentence
    if (d === undefined) return isSplitField(field) ? splitCategoryText(raw) : raw ? [raw] : [];
    if (Array.isArray(d)) return d;
    return typeof d === "boolean" ? [] : d ? [String(d)] : [];
  };
  report("dedupe", 36);

  const birthValues = parsed.rows.map((row) => valueOf(row, sources, "birthDate")).filter(Boolean);
  const savedDate = previousDictionary.find((d) => d.field === "birthDate" && d.kind === "date" && typeof d.value === "string")?.value as string | undefined;
  let dateFunction = savedDate || BUILTIN_DATE_FUNCTION;
  const parseDate = (value: string) => parseBuiltInDate(value) ?? (dateFunction === BUILTIN_DATE_FUNCTION ? null : parseAiDate(dateFunction, value));
  let dateSuccess = birthValues.filter((v) => !!parseDate(v)).length;
  report("dates", 40);
  if (birthValues.length && dateSuccess / birthValues.length < .9) {
    dateFunction = (await askDateParser(birthValues.slice(0, 40), input.signal)) || BUILTIN_DATE_FUNCTION;
    dateSuccess = birthValues.filter((v) => !!parseDate(v)).length;
  }
  const dateLoss = birthValues.length ? 1 - dateSuccess / birthValues.length : 0;
  const panicMessage = dateLoss > .1 ? "Não consegui identificar o formato de mais de 10% das datas. Use o formato brasileiro dd/MM/aaaa." : "";
  report("dates", 48);

  const rowsByBedroom = new Map<string, string[]>();
  for (const row of parsed.rows) {
    const raw = valueOf(row, sources, "bedroom");
    if (!raw) continue;
    const canonical = String(deduped.bedroom?.[raw] ?? raw);
    rowsByBedroom.set(canonical, [...(rowsByBedroom.get(canonical) ?? []), titleCaseName(valueOf(row, sources, "name"))]);
  }

  const resolution = new Map<string, unknown>();
  const tasks: Promise<void>[] = [];
  let crossingTotal = 0, crossingDone = 0;
  /** resolution tasks settle out of order while the list is still growing — the setter keeps pct monotonic */
  const track = (key: string, task: Promise<void>) => {
    crossingTotal++;
    return task.finally(() => { crossingDone++; report(key, 50 + (crossingDone / Math.max(crossingTotal, 1)) * 36); });
  };
  const uniqueCanonical = (field: string) => [...new Set(grouped[field as keyof typeof grouped].flatMap((raw) => atomsOf(field, raw)))];
  const seedSaved = (field: string) => {
    // split fields are seeded per atom by resolveCategoryValues — a legacy whole-cell id would poison the keys
    if (isSplitField(field)) return;
    const validIds = field === "bedroom" ? new Set(lookups.bedrooms.map((x) => x._id))
      : field === "transportation" ? new Set(lookups.transports.map((x) => x._id))
      : field === "team" ? new Set(lookups.teams.map((x) => x._id))
      : field === "leader" ? new Set(lookups.staff.map((x) => x._id))
      : new Set(lookups.categories.flatMap((x) => x.options.map((o) => o.id)));
    for (const raw of grouped[field as keyof typeof grouped]) {
      const saved = existingDict.get(`${field}:${normalize(raw)}`);
      if (typeof saved?.value === "string" && validIds.has(saved.value)) resolution.set(`${field}:${String(deduped[field]?.[raw] ?? raw)}`, saved.value);
    }
  };
  for (const field of ["transportation", "team", "bedroom", "leader", "bed", "allergies", "drugAllergies", "healthIssues"]) seedSaved(field);
  // One spreadsheet column usually mixes everything: medications, chronic
  // conditions and real allergy triggers. Ask the model where each atom
  // belongs before any option is matched or created.
  const healthFields = ["allergies", "drugAllergies", "healthIssues"] as const;
  const sourceField = new Map<string, string>();
  for (const field of healthFields) for (const atom of uniqueCanonical(field)) if (!sourceField.has(atom)) sourceField.set(atom, field);
  // Atoms seen only inside narrative cells (clinical histories, prophylaxis
  // instructions, dosage notes) never enter any health category — no match, no
  // new option. Their raw text stays in the notes for the background review.
  const narrativeBlocked = narrativeOnlyAtoms(healthFields.flatMap((field) => grouped[field].map((raw) => [raw, atomsOf(field, raw)] as [string, string[]])));
  const healthAtoms = [...new Set(healthFields.flatMap((field) => uniqueCanonical(field)))].filter((atom) => !narrativeBlocked.has(atom));
  const classification = await classifyImportItems(healthAtoms, input.signal, (atom) => sourceField.get(atom));
  report("categories", 49);
  /** the category an atom really belongs to — "" when it is not a health item at all */
  const bucketOf = (atom: string, fallback: string): string => {
    const answer = classification[atom];
    if (answer === "none") return "";
    return answer ?? fallback;
  };
  const bucketed = new Map<string, string>(healthAtoms.map((atom) => [atom, bucketOf(atom, sourceField.get(atom) ?? "")]));
  for (const canonical of uniqueCanonical("transportation")) if (!resolution.has(`transportation:${canonical}`)) tasks.push(track("crossing", resolveTransport(canonical, lookups, createdItems, input.importId, input.signal).then((id) => { resolution.set(`transportation:${canonical}`, id); })));
  for (const canonical of uniqueCanonical("team")) if (!resolution.has(`team:${canonical}`)) tasks.push(track("crossing", resolveTeam(canonical, lookups, createdItems, input.importId, input.signal).then((id) => { resolution.set(`team:${canonical}`, id); })));
  for (const canonical of uniqueCanonical("bedroom")) if (!resolution.has(`bedroom:${canonical}`)) tasks.push(track("crossing", resolveBedroom(canonical, rowsByBedroom.get(canonical) ?? [], lookups, createdItems, input.importId, input.signal).then((id) => { resolution.set(`bedroom:${canonical}`, id); })));
  // Each category mutates one options array, so values inside that category
  // are serial; the four independent categories still run in parallel.
  for (const field of ["bed", "allergies", "drugAllergies", "healthIssues"] as const) tasks.push(track("categories", (async () => {
    const values = (field === "bed" ? uniqueCanonical(field) : healthAtoms.filter((atom) => bucketed.get(atom) === field)).filter((canonical) => !resolution.has(`${field}:${canonical}`));
    const resolved = await resolveCategoryValues(field, values, lookups, createdItems, input.importId, input.signal);
    for (const [canonical, id] of resolved) resolution.set(`${field}:${canonical}`, id);
  })()));
  for (const canonical of uniqueCanonical("leader")) {
    tasks.push(track("leaders", (async () => {
      if (resolution.has(`leader:${canonical}`)) return;
      const match = deterministicLeader(canonical, staff);
      let id = match.id;
      if (!id && match.options.length <= 1) id = await matchLeaderWithAi(canonical, staff.map((s) => ({ id: s._id, name: s.name })), input.signal);
      resolution.set(`leader:${canonical}`, id);
      if (!id) resolution.set(`leaderOptions:${canonical}`, match.options.map((s) => ({ id: s._id, label: s.name })));
    })()));
  }
  report("crossing", 50);
  await Promise.all(tasks);
  report("preview", 88);

  for (const field of groupedFields) for (const raw of grouped[field]) {
    const normalized = normalize(raw);
    if (isSplitField(field)) {
      // one dictionary entry per (raw, atom) so the upsert key stays unique;
      // the atom may have been routed to another category
      for (const atom of atomsOf(field, raw)) {
        const bucket = bucketed.get(atom) ?? field;
        const value = bucket ? resolution.get(`${bucket}:${atom}`) ?? null : null;
        const label = lookups.categories.flatMap((x) => x.options).find((x) => x.id === value)?.label ?? atom;
        dictionaries.push({ field, raw, normalized: `${normalized}+${normalize(atom)}`, value, label, draft: true, kind: "category" });
      }
      continue;
    }
    const canonical = deduped[field]?.[raw] ?? raw;
    let value: unknown = canonical;
    let kind: CamperImportDictionaryEntry["kind"] = "text";
    if (field === "neurodivergent") { value = canonical === true; kind = "boolean"; }
    else if (["bedroom", "transportation", "team", "leader"].includes(field)) { value = resolution.get(`${field === "leader" ? "leader" : field}:${String(canonical)}`) ?? null; kind = field === "leader" ? "staff" : field as CamperImportDictionaryEntry["kind"]; }
    else if (["bed", "allergies", "drugAllergies", "healthIssues"].includes(field)) { value = resolution.get(`${field}:${String(canonical)}`) ?? null; kind = "category"; }
    const old = existingDict.get(`${field}:${normalized}`);
    const finalValue = value ?? old?.value ?? null;
    const resolvedLabel = typeof finalValue === "string"
      ? field === "bedroom" ? lookups.bedrooms.find((x) => x._id === finalValue)?.name
        : field === "transportation" ? lookups.transports.find((x) => x._id === finalValue) && transportLabel(lookups.transports.find((x) => x._id === finalValue)!)
          : field === "team" ? lookups.teams.find((x) => x._id === finalValue)?.name
            : field === "leader" ? lookups.staff.find((x) => x._id === finalValue)?.name
              : lookups.categories.flatMap((x) => x.options).find((x) => x.id === finalValue)?.label
      : null;
    dictionaries.push({ field, raw, normalized, value: finalValue, label: resolvedLabel || String(canonical), draft: true, kind });
  }
  dictionaries.push({ field: "birthDate", raw: "*", normalized: "*", value: dateFunction, label: "Função de data", draft: true, kind: "date" });
  for (const col of columns) dictionaries.push({ field: `column:${normalize(col.source)}`, raw: col.source, normalized: normalize(col.source), value: col.target, label: col.target ?? "Ignorar", draft: true, kind: "column" });

  const dictValue = (field: string, raw: string) => dictionaries.find((d) => d.field === field && d.normalized === normalize(raw))?.value;
  /** option id → the field that owns it, so an atom routed to another category lands in the right array */
  const optionCategory = new Map<string, string>();
  for (const [field, key] of Object.entries(CAMPER_CATEGORY_KEYS)) {
    const cat = lookups.categories.find((c) => c.key === key);
    for (const option of cat?.options ?? []) optionCategory.set(option.id, field);
  }
  /** option ids for every atom of a split-field cell ("Rinite, Asma" → both ids) */
  const dictIds = (field: string, raw: string): string[] => dictionaries.filter((d) => d.field === field && d.raw === raw && typeof d.value === "string").map((d) => d.value as string);
  const leaderReviews = new Map<string, CamperImportReviewItem>();

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const line = i + 2;
    const name = titleCaseName(valueOf(row, sources, "name"));
    const birthRaw = valueOf(row, sources, "birthDate");
    const birthDate = parseDate(birthRaw);
    const guardianName = titleCaseName(valueOf(row, sources, "guardianName"));
    const guardianPhoneRaw = valueOf(row, sources, "guardianPhone");
    const guardianPhone = importPhone(guardianPhoneRaw);
    const cpfRaw = valueOf(row, sources, "cpf");
    const guardianCpfRaw = valueOf(row, sources, "guardianCpf");
    const emailRaw = valueOf(row, sources, "guardianEmail");
    const email = validEmail(emailRaw);
    const probableGender = parseImportSex(valueOf(row, sources, "probableGender"));
    const leaderRaw = valueOf(row, sources, "leader");
    const leaderCanonical = String(deduped.leader?.[leaderRaw] ?? leaderRaw);
    const caretakerId = leaderRaw ? (dictValue("leader", leaderRaw) as string | null) : null;
    if (!birthDate) reviews.push(review("date", line, name, birthRaw, { guardianName, emergencyContact: valueOf(row, sources, "emergencyContact") }));
    const age = ageOfIso(birthDate);
    if (!guardianName) reviews.push(review("guardianName", line, name, "", { birthDate: birthDate ?? "", age, emergencyContact: valueOf(row, sources, "emergencyContact") }));
    if (!guardianPhone) reviews.push(review("phone", line, name, guardianPhoneRaw, { guardianName, emergencyContact: valueOf(row, sources, "emergencyContact") }));
    if (cpfRaw && !validCpf(cpfRaw)) reviews.push(review("cpf", line, name, cpfRaw, { field: "cpf", guardianName }));
    if (guardianCpfRaw && !validCpf(guardianCpfRaw)) reviews.push(review("cpf", line, name, guardianCpfRaw, { field: "guardianCpf", guardianName }));
    if (emailRaw && !email) reviews.push(review("email", line, name, emailRaw, { guardianName }));
    if (leaderRaw && !caretakerId) {
      const key = normalize(leaderCanonical);
      const existing = leaderReviews.get(key);
      if (existing) existing.affectedRows!.push(line);
      else {
        const item = review("leader", line, name, leaderRaw, { guardianName, affectedRows: [line], options: (resolution.get(`leaderOptions:${leaderCanonical}`) as { id: string; label: string }[] | undefined) ?? [] });
        leaderReviews.set(key, item);
        reviews.push(item);
      }
    }

    const allergiesRaw = valueOf(row, sources, "allergies");
    const drugRaw = valueOf(row, sources, "drugAllergies");
    const healthIssuesRaw = valueOf(row, sources, "healthIssues");
    const bedRaw = valueOf(row, sources, "bed");
    const allergyIds = allergiesRaw ? dictIds("allergies", allergiesRaw) : [];
    const drugIds = drugRaw ? dictIds("drugAllergies", drugRaw) : [];
    const healthIds = healthIssuesRaw ? dictIds("healthIssues", healthIssuesRaw) : [];
    // "Amoxicilina" written in the allergies column belongs to the medication
    // allergies array, "Asma" to the chronic conditions one.
    const byCategory: Record<string, string[]> = { allergies: [], drugAllergies: [], healthIssues: [] };
    for (const [field, ids] of [["allergies", allergyIds], ["drugAllergies", drugIds], ["healthIssues", healthIds]] as const)
      for (const id of ids) {
        const target = optionCategory.get(id) ?? field;
        if (byCategory[target] && !byCategory[target].includes(id)) byCategory[target].push(id);
      }
    // Kept only in the import preview. If the manager declines a newly
    // proposed category option, this tells Apply which original wording to
    // preserve in Observações for each affected child.
    const categoryNotesById: Record<string, string[]> = {};
    const rememberCategoryNote = (ids: string[], label: string, raw: string) => {
      if (!raw) return;
      const note = `${label}: ${raw}.`;
      for (const id of ids) {
        const notes = categoryNotesById[id] ?? [];
        if (!notes.includes(note)) notes.push(note);
        categoryNotesById[id] = notes;
      }
    };
    rememberCategoryNote(allergyIds, "Alergias informadas", allergiesRaw);
    rememberCategoryNote(drugIds, "Alergias a medicamentos informadas", drugRaw);
    rememberCategoryNote(healthIds, "Condições de saúde informadas", healthIssuesRaw);
    const bedId = bedRaw ? dictValue("bed", bedRaw) : null;
    if (typeof bedId === "string") rememberCategoryNote([bedId], "Posição da cama informada", bedRaw);
    /** any atom without an option keeps the raw text visible in the notes */
    const partial = (ids: string[], field: string, raw: string) => ids.length < Math.max(atomsOf(field, raw).length, 1);
    const notePieces = [
      valueOf(row, sources, "dailyMedication") && `Medicação de uso diário: ${valueOf(row, sources, "dailyMedication")}.`,
      valueOf(row, sources, "foodRestrictions") && `Restrição alimentar: ${valueOf(row, sources, "foodRestrictions")}.`,
      valueOf(row, sources, "healthNotes") && `Observações médicas: ${valueOf(row, sources, "healthNotes")}.`,
      allergiesRaw && !isEmptyCategoryValue(allergiesRaw) && partial(allergyIds, "allergies", allergiesRaw) && `Alergias informadas: ${allergiesRaw}.`,
      drugRaw && !isEmptyCategoryValue(drugRaw) && partial(drugIds, "drugAllergies", drugRaw) && `Alergias a medicamentos informadas: ${drugRaw}.`,
      healthIssuesRaw && !isEmptyCategoryValue(healthIssuesRaw) && partial(healthIds, "healthIssues", healthIssuesRaw) && `Condições de saúde informadas: ${healthIssuesRaw}.`,
      valueOf(row, sources, "generalNotes"),
      concatOtherColumns(row, mappedSources),
    ].filter(Boolean).join(" ").trim();
    const item = {
      row: line,
      name,
      birthDate,
      // The registration answer is not the operational room sex. It is kept
      // as the client's explicit probable gender and is never guessed here.
      sex: null,
      probableGender,
      cpf: validCpf(cpfRaw),
      rg: valueOf(row, sources, "rg"),
      school: valueOf(row, sources, "school"),
      schoolGrade: valueOf(row, sources, "schoolGrade"),
      church: valueOf(row, sources, "church"),
      invitedBy: valueOf(row, sources, "invitedBy"),
      caretakerId,
      team: valueOf(row, sources, "team") ? dictValue("team", valueOf(row, sources, "team")) ?? null : null,
      transportation: valueOf(row, sources, "transportation") ? dictValue("transportation", valueOf(row, sources, "transportation")) ?? null : null,
      bed: bedRaw ? dictValue("bed", bedRaw) ?? null : null,
      bedroom: valueOf(row, sources, "bedroom") ? dictValue("bedroom", valueOf(row, sources, "bedroom")) ?? null : null,
      weightKg: parseWeight(valueOf(row, sources, "weightKg")),
      allergies: byCategory.allergies,
      drugAllergies: byCategory.drugAllergies,
      healthIssues: byCategory.healthIssues,
      neurodivergent: valueOf(row, sources, "neurodivergent") ? dictValue("neurodivergent", valueOf(row, sources, "neurodivergent")) === true : false,
      medications: [],
      foodRestrictions: valueOf(row, sources, "foodRestrictions"),
      healthNotes: valueOf(row, sources, "healthNotes"),
      generalNotes: notePieces,
      bedroomPreference: valueOf(row, sources, "bedroomPreference"),
      insurance: valueOf(row, sources, "insurance"),
      insuranceCard: valueOf(row, sources, "insuranceCard"),
      emergencyContact: valueOf(row, sources, "emergencyContact"),
      guardianName,
      guardianPhone,
      guardianCpf: validCpf(guardianCpfRaw),
      guardianEmail: email,
      dailyMedicationText: valueOf(row, sources, "dailyMedication"),
      foodRestrictionText: valueOf(row, sources, "foodRestrictions"),
      categoryNotesById,
    };
    const identity=camperIdentityKey(name,birthDate),existing=identity?existingCampers.find((camper)=>camperIdentityKey(camper.name,camper.birthDate)===identity):null;
    const incoming:Record<string,unknown>={...item,blocked:false}, existingData:Record<string,unknown>|undefined=existing?{...existing}:undefined;
    const existingForChoice=existingData?{...existingData}:undefined;for(const key of ["_id","createdAt","updatedAt","checkin","busCheckin","busReturnCheckin","parentEditedAt"])if(existingForChoice)delete existingForChoice[key];
    // Operational allocations are never replaced by a registration spreadsheet.
    // Show and apply the values that will actually remain in the system.
    const effectiveIncoming={...incoming};for(const key of ["bedroom","team","caretakerId","transportation"] as const)if(existingForChoice)effectiveIncoming[key]=existingForChoice[key]??null;
    const hasValue=(value:unknown)=>Array.isArray(value)?value.length>0:value!==null&&value!==undefined&&value!==""&&value!==false;
    const mergeValue=(oldValue:unknown,newValue:unknown)=>{if(Array.isArray(oldValue)||Array.isArray(newValue))return [...new Set([...(Array.isArray(oldValue)?oldValue:[]),...(Array.isArray(newValue)?newValue:[])])];return hasValue(newValue)?newValue:oldValue;};
    const mergedData=existingForChoice?Object.fromEntries([...new Set([...Object.keys(existingForChoice),...Object.keys(effectiveIncoming)])].map((key)=>[key,mergeValue(existingForChoice[key],effectiveIncoming[key])])):undefined;
    const mergeAvailable=!!existingForChoice&&!!mergedData&&JSON.stringify(mergedData)!==JSON.stringify(existingForChoice)&&JSON.stringify(mergedData)!==JSON.stringify(effectiveIncoming);
    if(existing){reviews.push(review("duplicate",line,name,"",{value:"",existingId:existing._id,existingData:existingForChoice,incomingData:effectiveIncoming,mergedData,mergeAvailable,birthDate:birthDate??"",guardianName}));}
    const blocking = !name || !birthDate || !guardianName || !guardianPhone || (!!leaderRaw && !caretakerId);
    if (blocking) skipped.push({ row: line, name, reason: !name ? "Nome ausente" : !birthDate ? "Data inválida" : !guardianName ? "Responsável ausente" : !guardianPhone ? "Telefone inválido" : "Líder não encontrado" });
    preview.push({ ...item, duplicateExistingId:existing?._id??null, duplicateChoice:existing?null:undefined, blocked: blocking||!!existing });
  }
  report("preview", 96);

  const status = panicMessage ? "panic" : reviews.some((r) => ["leader", "date", "guardianName", "phone", "duplicate"].includes(r.kind)) ? "review" : "ready";
  return { columns, rows: parsed.rows, dictionaries, reviews, preview, skipped, createdItems, dateFunction, status, panicMessage };
}

export function applyCategoryChoices(preview: Record<string, unknown>[], declinedIds: string[]): Record<string, unknown>[] {
  if (!declinedIds.length) return preview.map((row) => ({ ...row }));
  const declined = new Set(declinedIds);
  const fields = ["bed", "allergies", "drugAllergies", "healthIssues"] as const;
  return preview.map((source) => {
    const row = { ...source };
    const notesById = row.categoryNotesById && typeof row.categoryNotesById === "object" ? row.categoryNotesById as Record<string, string[]> : {};
    const notes: string[] = [];
    for (const field of fields) {
      if (field === "bed") {
        const id = typeof row.bed === "string" ? row.bed : "";
        if (id && declined.has(id)) {
          row.bed = null;
          notes.push(...(notesById[id] ?? []));
        }
        continue;
      }
      const ids = Array.isArray(row[field]) ? row[field] as string[] : [];
      const removed = ids.filter((id) => declined.has(id));
      row[field] = ids.filter((id) => !declined.has(id));
      for (const id of removed) notes.push(...(notesById[id] ?? []));
    }
    if (notes.length) row.generalNotes = [String(row.generalNotes ?? "").trim(), ...new Set(notes)].filter(Boolean).join(" ");
    return row;
  });
}

export function applyImportDelta(preview: Record<string, unknown>[], reviews: CamperImportReviewItem[], delta: Record<string, { value?: string; skip?: boolean }>): { rows: Record<string, unknown>[]; skipped: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = preview.map((r) => ({ ...r, blocked: false }));
  const skipped: Record<string, unknown>[] = [];
  const blockedRows = new Set<number>();
  for (const item of reviews) {
    const change = delta[item.id] ?? {};
    const affectedRows = new Set(item.affectedRows?.length ? item.affectedRows : [item.row]);
    const targets = rows.filter((r) => affectedRows.has(Number(r.row)));
    if (!targets.length) continue;
    const value = (change.value ?? item.value).trim();
    const skip = change.skip ?? item.skip;
    if (skip) {
      if (["leader", "date", "guardianName", "phone", "duplicate"].includes(item.kind)) {
        for (const row of targets) {
          row.blocked = true;
          blockedRows.add(Number(row.row));
        }
      }
      continue;
    }
    for (const row of targets) {
      if (item.kind === "leader") {
        const allowed = !!value && ((item.resolved && value === item.value) || (item.options ?? []).some((option) => option.id === value));
        row.caretakerId = allowed ? value : null;
        if (!allowed) blockedRows.add(Number(row.row));
      }
      else if (item.kind === "date") row.birthDate = parseBuiltInDate(value);
      else if (item.kind === "guardianName") row.guardianName = titleCaseName(value);
      else if (item.kind === "phone") row.guardianPhone = importPhone(value);
      else if (item.kind === "cpf") row[item.field] = validCpf(value);
      else if (item.kind === "email") row.guardianEmail = validEmail(value);
      else if (item.kind === "duplicate") {
        const choice=["update","keep","merge"].includes(value)?value:"";
        row.duplicateChoice=choice;
        row.existingCamperId=item.existingId??null;
        if(choice==="keep")row.blocked=true;
        else if(choice==="merge"&&item.mergedData)Object.assign(row,item.mergedData,{row:row.row,duplicateChoice:choice,existingCamperId:item.existingId??null,blocked:false});
        else if(choice==="update"&&item.incomingData)Object.assign(row,item.incomingData,{row:row.row,duplicateChoice:choice,existingCamperId:item.existingId??null,blocked:false});
        else blockedRows.add(Number(row.row));
      }
    }
  }
  for (const row of rows) {
    let reason = row.duplicateChoice==="keep"?"Cadastro existente mantido":blockedRows.has(Number(row.row)) ? "Revisão obrigatória ignorada" : "";
    if (!row.name) reason = "Nome ausente";
    else if (!row.birthDate) reason = "Data inválida";
    else if (!row.guardianName) reason = "Responsável ausente";
    else if (row.guardianPhone === null) reason = "Telefone inválido";
    if (reason) {
      row.blocked = true;
      skipped.push({ row: row.row, name: row.name, reason });
    }
  }
  return { rows, skipped };
}

/** A leader named in the spreadsheet but not on the team: registered in core (`equipe`) and added as a DRAFT caretaker. */
export async function createLeaderFromReview(name: string, phone: string, importId: string, ctx: ImportCoreContext): Promise<NamedStaff> {
  const normalized = normalizeBrazilPhone(phone);
  if (!normalized) throw new Error("Informe um celular brasileiro válido com DDD.");
  const clean = titleCaseName(name);
  const { personId } = await registerAdult(ctx.tokens, { name: clean, phone: normalized, roles: [TEAM_ROLE], editionId: ctx.editionId });
  const existing = (await listStaff({ includeDraft: true, personIds: [personId] }))[0];
  const staff = existing ?? (await insertStaff(personId, { ...EMPTY_STAFF, roomRole: "caretaker", draft: true, importId }));
  return { ...staff, name: clean };
}

/** One preview row → what goes where: camp ops (Acampa), the kid + guardian (persons-api), health (persons-api `medical`). */
export function camperDataFromPreview(row: Record<string, unknown>, importId: string): { ops: CamperData; kid: { name: string; birthDate: string; sex: CamperSex | null; homeChurch: string; data: Record<string, unknown> }; guardian: { name: string; phone: string | null; email: string; data: Record<string, unknown> }; health: Partial<HealthInfo> } | null {
  if (row.blocked === true || !row.name || !row.birthDate) return null;
  const kidData: Record<string, unknown> = {};
  const docs = documentsOf({ cpf: String(row.cpf ?? ""), rg: String(row.rg ?? "") });
  if (docs.length) kidData.document = docs;
  if (row.school || row.schoolGrade) kidData.school = { name: String(row.school ?? ""), grade: String(row.schoolGrade ?? "") };
  const emergency = emergencyContactOf(String(row.emergencyContact ?? ""));
  if (emergency) kidData.emergencyContact = emergency;
  const guardianDocs = documentsOf({ cpf: String(row.guardianCpf ?? "") });
  return {
    ops: {
      ...EMPTY_CAMPER,
      invitedBy: String(row.invitedBy ?? ""),
      caretakerId: (row.caretakerId as string | null) ?? null,
      team: (row.team as string | null) ?? null,
      transportation: (row.transportation as string | null) ?? null,
      bed: (row.bed as string | null) ?? null,
      bedroom: (row.bedroom as string | null) ?? null,
      // the free-text observations stay with the camp (decision 33); the AI triage moves health out of them
      generalNotes: String(row.generalNotes ?? ""),
      bedroomPreference: String(row.bedroomPreference ?? ""),
      importId,
      aiReviewStatus: "pending",
      aiReviewError: "",
      aiReviewStartedAt: null,
      aiReviewFinishedAt: null,
      aiReviewAttempts: 0,
      aiReviewNextRetryAt: null,
    },
    // sex only when the sheet said it explicitly (never guessed); the church column → core `homeChurch`
    kid: { name: String(row.name), birthDate: String(row.birthDate), sex: row.probableGender === "F" || row.probableGender === "M" ? row.probableGender : null, homeChurch: String(row.church ?? "").trim(), data: kidData },
    guardian: { name: String(row.guardianName ?? ""), phone: (row.guardianPhone as string | null) ?? null, email: String(row.guardianEmail ?? ""), data: guardianDocs.length ? { document: guardianDocs } : {} },
    health: {
      allergies: (row.allergies as string[]) ?? [],
      drugAllergies: (row.drugAllergies as string[]) ?? [],
      healthIssues: (row.healthIssues as string[]) ?? [],
      neurodivergent: row.neurodivergent === true,
      foodRestrictions: String(row.foodRestrictions ?? "").slice(0, 300),
      healthNotes: String(row.healthNotes ?? "").slice(0, 2000),
      ...(typeof row.weightKg === "number" ? { weightKg: row.weightKg } : {}),
      insurance: String(row.insurance ?? "").slice(0, 60),
      insuranceCard: String(row.insuranceCard ?? "").slice(0, 60),
    },
  };
}

export async function discardImportCategoryOptions(importId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getDb();
  const now = new Date();
  await Promise.all([
    db.collection<Record<string, unknown>>("categories").updateMany(
      { "options.id": { $in: ids }, "options.importId": importId },
      { $pull: { options: { id: { $in: ids }, importId } } as never, $set: { updatedAt: now } },
    ),
    db.collection("camperImportDictionary").updateMany(
      { importId, value: { $in: ids } },
      { $set: { value: null, draft: false, updatedAt: now } },
    ),
  ]);
}

export async function publishImportDrafts(importId: string): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await Promise.all([
    db.collection("bedrooms").updateMany({ importId, draft: true }, { $set: { draft: false, updatedAt: now } }),
    db.collection("transports").updateMany({ importId, draft: true }, { $set: { draft: false, updatedAt: now } }),
    db.collection("teams").updateMany({ importId, draft: true }, { $set: { draft: false, updatedAt: now } }),
    db.collection("participants").updateMany({ kind: "team", importId, draft: true }, { $set: { draft: false, updatedAt: now } }),
    db.collection("categories").updateMany({ "options.importId": importId }, { $set: { "options.$[option].draft": false, updatedAt: now } }, { arrayFilters: [{ "option.importId": importId }] }),
  ]);
}

/**
 * Applies the reviewed rows: each kid + responsável is registered in core
 * (persons registration + `participante` / `responsavel` memberships of the
 * camp's edition, health in persons-api) with the coordenação tokens, then
 * the camp-ops row is written (or updated, for a duplicate the reviewer
 * chose to update / merge). The AI triage of the observations runs later in
 * the worker, which writes health straight to persons-api with the importer's
 * token sealed on the import job (decision 50).
 */
export async function insertImportCampers(rows: Record<string, unknown>[], importId: string, ctx: ImportCoreContext): Promise<{ inserted: number; updated: number; skipped: Record<string, unknown>[] }> {
  let inserted = 0;
  let updated = 0;
  const skipped: Record<string, unknown>[] = [];
  const rooms = await listBedrooms({ includeDraft: true });
  for (const row of rows) {
    const data = camperDataFromPreview(row, importId);
    if (!data) {
      skipped.push({ row: row.row, name: row.name, reason: "Campos obrigatórios não revisados" });
      continue;
    }
    const room = data.ops.bedroom ? rooms.find((b) => b._id === data.ops.bedroom) : null;
    if (room && bedroomCapacity(room) <= 0) {
      skipped.push({ row: row.row, name: row.name, reason: "Quarto sem camas" });
      continue;
    }
    const existingId = typeof row.existingCamperId === "string" ? row.existingCamperId : "";
    const choice = String(row.duplicateChoice ?? "");
    if (choice === "keep") {
      skipped.push({ row: row.row, name: row.name, reason: "Cadastro existente mantido" });
      continue;
    }
    if (existingId && ["update", "merge"].includes(choice)) {
      const camper = await updateCamper(existingId, data.ops);
      if (!camper) {
        skipped.push({ row: row.row, name: row.name, reason: "Cadastro existente não encontrado" });
        continue;
      }
      try {
        // the sheet's responsável joins the SAME kid (link, decision 38) — never a second copy of the kid
        if (data.guardian.phone && data.guardian.name) await addResponsible(ctx.tokens, { kidId: existingId, guardian: { name: data.guardian.name, phone: data.guardian.phone, email: data.guardian.email || undefined, data: data.guardian.data }, editionId: ctx.editionId });
        const current = (await readHealth(ctx.tokens.persons, existingId)) ?? { ...EMPTY_HEALTH };
        const patch = mergeHealth(current, await healthToCore(ctx.tokens.persons, data.health));
        if (Object.keys(patch).length) await writeHealth(ctx.tokens.persons, existingId, patch, current);
      } catch (err) {
        if (!(err instanceof IpalphaRejected)) throw err;
        skipped.push({ row: row.row, name: row.name, reason: `Atualizado no acampamento; o IPAlpha recusou parte dos dados (${err.reason})` });
      }
      updated++;
      continue;
    }
    if (!data.guardian.phone || !data.guardian.name) {
      skipped.push({ row: row.row, name: row.name, reason: "Responsável sem nome ou celular" });
      continue;
    }
    try {
      const { kidId } = await registerKid(ctx.tokens, { kid: data.kid, guardian: { name: data.guardian.name, phone: data.guardian.phone, email: data.guardian.email || undefined, data: data.guardian.data }, editionId: ctx.editionId, health: data.health });
      if (await findCamperById(kidId)) {
        await updateCamper(kidId, data.ops);
        updated++;
      } else {
        await insertCamper(kidId, data.ops);
        inserted++;
      }
    } catch (err) {
      // a refusal for THIS row is reported; a revoked token / outage stops the apply (the caller answers it)
      if (!(err instanceof IpalphaRejected)) throw err;
      skipped.push({ row: row.row, name: row.name, reason: `O IPAlpha recusou o cadastro (${err.reason})` });
    }
  }
  return { inserted, updated, skipped };
}
