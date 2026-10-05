import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireAdmin, requireManager } from "../middleware/roles";
import { cleanHtml } from "../services/html";
import { clearSeeds, getSeeds, saveSeeds } from "../models/seeds";
import type { SeedBus, SeedDocs, SeedEvent, SeedPlace, SeedPlaceRoom, SeedRole, Seeds } from "../types";

type Env = { Variables: AuthVariables };

const seeds = new Hono<Env>();

/** The deployment owners (SUPER_ADMIN_PERSON_IDS) — the only ones who may change the seeds. */
function isSuperAdmin(c: Context<Env>): boolean {
  return c.get("user").superAdmin;
}

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

// ── validation (light: shapes, sizes and sane values) ──────────────────────

const GROUPS = ["girls", "boys", "staff"] as const;
const ROOM_ROLES = ["caretaker", "helper"] as const;
const TIME_RE = /^\d{2}:\d{2}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const str = (v: unknown, max: number, label: string, required = false): string | { error: string } => {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") return { error: `${label} inválido.` };
  const s = v.trim();
  if (required && !s) return { error: `${label} é obrigatório.` };
  return s.length <= max ? s : { error: `${label} passa de ${max} caracteres.` };
};

const int = (v: unknown, min: number, max: number, label: string): number | { error: string } => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return { error: `${label} precisa estar entre ${min} e ${max}.` };
  return n;
};

const coord = (v: unknown, bounds: number, label: string): number | null | { error: string } => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > bounds) return { error: `${label} inválido.` };
  return n;
};

function parseRooms(value: unknown): SeedPlaceRoom[] | { error: string } {
  if (!Array.isArray(value)) return { error: "Quartos inválidos." };
  if (value.length > 80) return { error: "Quartos demais (máx. 80 por local)." };
  const out: SeedPlaceRoom[] = [];
  for (const raw of value) {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!o) return { error: "Quarto inválido." };
    const name = str(o.name, 40, "Nome do quarto", true);
    if (typeof name !== "string") return name;
    const bunkBeds = int(o.bunkBeds ?? 0, 0, 30, "Beliches");
    if (typeof bunkBeds !== "number") return bunkBeds;
    const singleBeds = int(o.singleBeds ?? 0, 0, 30, "Camas de solteiro");
    if (typeof singleBeds !== "number") return singleBeds;
    if (!GROUPS.includes(o.group as never)) return { error: `${name}: ala inválida.` };
    out.push({ name, group: o.group as SeedPlaceRoom["group"], bunkBeds, singleBeds });
  }
  return out;
}

function parsePlaces(value: unknown): SeedPlace[] | { error: string } {
  if (!Array.isArray(value)) return { error: "Locais inválidos." };
  if (value.length > 10) return { error: "Locais demais (máx. 10)." };
  const out: SeedPlace[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!o) return { error: "Local inválido." };
    const id = str(o.id, 40, "Identificador do local", true);
    if (typeof id !== "string") return id;
    if (ids.has(id)) return { error: `Local "${id}" repetido.` };
    ids.add(id);
    const name = str(o.name, 80, "Nome do local", true);
    if (typeof name !== "string") return name;
    const address = str(o.address, 200, "Endereço");
    if (typeof address !== "string") return address;
    const notes = str(o.notes, 300, "Observações");
    if (typeof notes !== "string") return notes;
    const lat = coord(o.lat, 90, "Latitude");
    if (typeof lat === "object" && lat && "error" in lat) return lat;
    const lng = coord(o.lng, 180, "Longitude");
    if (typeof lng === "object" && lng && "error" in lng) return lng;
    const rooms = parseRooms(o.rooms);
    if (!Array.isArray(rooms)) return rooms;
    out.push({ id, name, address, notes: notes || undefined, lat, lng, rooms });
  }
  return out;
}

function parseRoles(value: unknown): SeedRole[] | { error: string } {
  if (!Array.isArray(value)) return { error: "Funções inválidas." };
  if (value.length > 80) return { error: "Funções demais (máx. 80)." };
  const out: SeedRole[] = [];
  const keys = new Set<string>();
  for (const raw of value) {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!o) return { error: "Função inválida." };
    const key = str(o.key, 40, "Chave da função", true);
    if (typeof key !== "string") return key;
    if (keys.has(key)) return { error: `Função "${key}" repetida.` };
    keys.add(key);
    const name = str(o.name, 80, "Nome da função", true);
    if (typeof name !== "string") return name;
    const emoji = str(o.emoji, 16, "Emblema da função", true);
    if (typeof emoji !== "string") return emoji;
    const forRoomRoles = Array.isArray(o.forRoomRoles) ? (o.forRoomRoles as unknown[]).filter((r): r is SeedRole["forRoomRoles"][number] => ROOM_ROLES.includes(r as never)) : [];
    const detailPlaceholder = str(o.detailPlaceholder, 40, "Dica do detalhe");
    if (typeof detailPlaceholder !== "string") return detailPlaceholder;
    out.push({
      key,
      name,
      emoji,
      forRoomRoles,
      hasDetail: o.hasDetail === true,
      detailFromTeam: o.detailFromTeam === true,
      detailPlaceholder: detailPlaceholder || undefined,
    });
  }
  return out;
}

function parseEvents(value: unknown, roles: SeedRole[]): SeedEvent[] | { error: string } {
  if (!Array.isArray(value)) return { error: "Eventos inválidos." };
  if (value.length > 200) return { error: "Eventos demais (máx. 200)." };
  const roleKeys = new Set(roles.map((r) => r.key));
  const out: SeedEvent[] = [];
  for (const raw of value) {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!o) return { error: "Evento inválido." };
    const day = int(o.day, 1, 3, "Dia");
    if (typeof day !== "number") return day;
    const start = str(o.start, 5, "Horário");
    if (typeof start !== "string" || !TIME_RE.test(start)) return { error: "Horário inválido (use HH:MM)." };
    let end: string | null = null;
    if (o.end !== null && o.end !== undefined && o.end !== "") {
      const e = str(o.end, 5, "Fim");
      if (typeof e !== "string" || !TIME_RE.test(e)) return { error: "Fim inválido (use HH:MM)." };
      end = e;
    }
    const title = str(o.title, 80, "Título", true);
    if (typeof title !== "string") return title;
    const emoji = str(o.emoji, 16, "Emblema", true);
    if (typeof emoji !== "string") return emoji;
    const notes = str(o.notes, 300, "Observações");
    if (typeof notes !== "string") return notes;
    const evRoles = Array.isArray(o.roles) ? (o.roles as unknown[]).filter((r): r is string => typeof r === "string" && roleKeys.has(r)) : [];
    out.push({ day, start, end, title, emoji, roles: evRoles, visibleToParents: o.visibleToParents === undefined ? true : o.visibleToParents !== false, notes: notes || undefined });
  }
  return out;
}

function parseFleet(value: unknown): SeedBus[] | { error: string } {
  if (!Array.isArray(value)) return { error: "Frota inválida." };
  if (value.length > 20) return { error: "Veículos demais (máx. 20)." };
  const out: SeedBus[] = [];
  for (const raw of value) {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!o) return { error: "Veículo inválido." };
    const number = str(o.number, 10, "Número", true);
    if (typeof number !== "string") return number;
    const color = str(o.color, 7, "Cor");
    if (typeof color !== "string" || !HEX_RE.test(color)) return { error: `${number}: cor inválida (use #rrggbb).` };
    let capacity: number | null = null;
    if (o.capacity !== null && o.capacity !== undefined && o.capacity !== "") {
      const c = int(o.capacity, 1, 99, "Lugares");
      if (typeof c !== "number") return c;
      capacity = c;
    }
    out.push({ number, color, capacity });
  }
  return out;
}

function parseDocs(value: unknown): SeedDocs | { error: string } {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!o) return { error: "Documentos inválidos." };
  const prepTitle = str(o.prepTitle, 80, "Título da preparação", true);
  if (typeof prepTitle !== "string") return prepTitle;
  const prepEmoji = str(o.prepEmoji, 16, "Emblema da preparação", true);
  if (typeof prepEmoji !== "string") return prepEmoji;
  const addressTitle = str(o.addressTitle, 80, "Título da instrução", true);
  if (typeof addressTitle !== "string") return addressTitle;
  const addressEmoji = str(o.addressEmoji, 16, "Emblema da instrução", true);
  if (typeof addressEmoji !== "string") return addressEmoji;
  const prepContent = cleanHtml(o.prepContent, 30_000) ?? "";
  return { prepTitle, prepEmoji, prepContent, addressTitle, addressEmoji };
}

/** Validates the whole payload; returns the canonical Seeds to store. */
function parseSeeds(value: unknown): Seeds | { error: string } {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!o) return { error: "Informe as sementes." };
  const places = parsePlaces(o.places);
  if (!Array.isArray(places)) return places;
  const roles = parseRoles(o.roles);
  if (!Array.isArray(roles)) return roles;
  const events = parseEvents(o.events, roles);
  if (!Array.isArray(events)) return events;
  const fleet = parseFleet(o.fleet);
  if (!Array.isArray(fleet)) return fleet;
  const docs = parseDocs(o.docs);
  if (!("prepTitle" in docs)) return docs;
  return { places, roles, events, fleet, docs, updatedAt: null };
}

seeds.use("*", requireAuth);

/** GET /api/seeds — admin / organizer (the wizard reads its templates here). `seeds: null` = the app's built-in defaults. */
seeds.get("/", requireManager, async (c) => c.json({ seeds: await getSeeds() }));

/** PUT /api/seeds — SUPER ADMIN only. Replaces the whole seeds document the wizard imports from. */
seeds.put("/", requireAdmin, async (c) => {
  if (!isSuperAdmin(c)) return fail(c, "SUPER_ADMIN_ONLY", "Só o administrador da implantação (SUPER_ADMIN_PERSON_IDS) mantém as sementes.", 403);
  const body = await c.req.json().catch(() => null);
  const parsed = parseSeeds(body);
  if (!("places" in parsed)) return fail(c, "SEEDS_INVALID", parsed.error);
  const saved = await saveSeeds(parsed);
  console.log("🌱 seeds updated");
  return c.json({ seeds: saved });
});

/** DELETE /api/seeds — SUPER ADMIN only. "Restaurar tudo": back to the app's built-in defaults. */
seeds.delete("/", requireAdmin, async (c) => {
  if (!isSuperAdmin(c)) return fail(c, "SUPER_ADMIN_ONLY", "Só o administrador da implantação (SUPER_ADMIN_PERSON_IDS) mantém as sementes.", 403);
  await clearSeeds();
  console.log("🌱 seeds reset");
  return c.json({ seeds: null });
});

export default seeds;
