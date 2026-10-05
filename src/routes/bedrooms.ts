import { Hono, type Context } from "hono";
import { publish } from "../services/realtime";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireManager, requireRole } from "../middleware/roles";
import {
  applyBedroomGroupToOccupants,
  countStaffPerBedroom,
  deleteBedroom,
  findBedroomById,
  findBedroomByName,
  insertBedroom,
  listBedrooms,
  sexOfGroup,
  updateBedroom,
  type BedroomData,
} from "../models/bedrooms";
import { countCampersPerBedroom, listCampers, updateCamper } from "../models/campers";
import { listStaff, updateStaff } from "../models/staff";
import { BEDROOM_GROUPS, bedroomCapacity, ROOM_ROLES, type Bedroom, type BedroomGroup, type RoomRole } from "../types";
import { serializeCamperList } from "./campers";
import { serializeStaffList } from "./staff";
import { canSeeBedroom, resolveScope } from "../services/scope";
import { notifyRoomsApplied, roomsAppliedMessages } from "../services/notify";
import { getSettings } from "../models/settings";
import { firstName, namesOf } from "../services/people";

type Env = { Variables: AuthVariables };

const bedrooms = new Hono<Env>();

const NAME_MAX = 30;
const NOTES_MAX = 300;
const BEDS_MAX = 50;

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

interface Occupancy {
  staff: number;
  campers: number;
}

/** staff + campers per bedroom id */
export async function occupancy(): Promise<Map<string, Occupancy>> {
  const [s, k] = await Promise.all([countStaffPerBedroom(), countCampersPerBedroom()]);
  const m = new Map<string, Occupancy>();
  for (const [id, n] of s) m.set(id, { staff: n, campers: 0 });
  for (const [id, n] of k) m.set(id, { ...(m.get(id) ?? { staff: 0, campers: 0 }), campers: n });
  return m;
}

const NONE: Occupancy = { staff: 0, campers: 0 };

export function serializeBedroom(b: Bedroom, occ: Occupancy = NONE) {
  const capacity = bedroomCapacity(b);
  const occupied = occ.staff + occ.campers;
  return {
    id: b._id,
    name: b.name,
    group: b.group,
    bunkBeds: b.bunkBeds,
    singleBeds: b.singleBeds,
    capacity,
    occupied,
    occupiedStaff: occ.staff,
    occupiedCampers: occ.campers,
    available: capacity - occupied,
    notes: b.notes,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

function parseBeds(value: unknown, fallback: number | undefined): number | null {
  if (value === undefined) return fallback ?? null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > BEDS_MAX) return null;
  return n;
}

/** Validates the body; `partial` (PUT) only touches keys that are present. */
function buildPatch(
  body: Record<string, unknown>,
  partial: boolean,
): { patch: Partial<BedroomData> } | { code: string; message: string } {
  const patch: Partial<BedroomData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("name")) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > NAME_MAX) {
      return { code: "NAME_INVALID", message: `Informe o nome/número do quarto com até ${NAME_MAX} caracteres.` };
    }
    patch.name = name;
  }

  if (has("group")) {
    if (!BEDROOM_GROUPS.includes(body.group as BedroomGroup)) {
      return { code: "GROUP_INVALID", message: "Ala inválida. Use meninas, meninos ou equipe." };
    }
    patch.group = body.group as BedroomGroup;
  }

  if (has("bunkBeds")) {
    const n = parseBeds(body.bunkBeds, 0);
    if (n === null) return { code: "BUNK_BEDS_INVALID", message: `Beliches deve ser um número entre 0 e ${BEDS_MAX}.` };
    patch.bunkBeds = n;
  }

  if (has("singleBeds")) {
    const n = parseBeds(body.singleBeds, 0);
    if (n === null) {
      return { code: "SINGLE_BEDS_INVALID", message: `Camas de solteiro deve ser um número entre 0 e ${BEDS_MAX}.` };
    }
    patch.singleBeds = n;
  }

  if (has("notes")) {
    if (body.notes !== undefined && typeof body.notes !== "string") {
      return { code: "NOTES_INVALID", message: "Observações inválidas." };
    }
    patch.notes = ((body.notes as string | undefined) ?? "").trim().slice(0, NOTES_MAX);
  }

  return { patch };
}

bedrooms.use("*", requireAuth);

// ── read: admin sees every room; staff/health staff only their own (see services/scope.ts) ──

/** GET /api/bedrooms?group=girls|boys|staff — sorted by group then number (scoped). */
bedrooms.get("/", requireRole("admin", "staff", "parent"), async (c) => {
  const group = c.req.query("group");
  if (group && !BEDROOM_GROUPS.includes(group as BedroomGroup)) {
    return fail(c, "GROUP_INVALID", "Ala inválida. Use girls, boys ou staff.");
  }
  const [list, occ, scope] = await Promise.all([
    listBedrooms({ group: group as BedroomGroup | undefined }),
    occupancy(),
    resolveScope(c.get("user")),
  ]);
  return c.json({ bedrooms: list.filter((b) => canSeeBedroom(scope, b._id)).map((b) => serializeBedroom(b, occ.get(b._id))) });
});

bedrooms.get("/:id", requireRole("admin", "staff", "parent"), async (c) => {
  const b = await findBedroomById(c.req.param("id"));
  // outside the viewer's scope → same answer as "does not exist" (no probing)
  if (!b || !canSeeBedroom(await resolveScope(c.get("user")), b._id)) return fail(c, "BEDROOM_NOT_FOUND", "Quarto não encontrado.", 404);
  const occ = await occupancy();
  return c.json({ bedroom: serializeBedroom(b, occ.get(b._id)) });
});

/** GET /api/bedrooms/:id/detail — the room + who sleeps there (campers and staff caretakers). */
bedrooms.get("/:id/detail", requireRole("admin", "staff"), async (c) => {
  const b = await findBedroomById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  if (!b || !canSeeBedroom(scope, b._id)) return fail(c, "BEDROOM_NOT_FOUND", "Quarto não encontrado.", 404);
  const [campers, allStaff] = await Promise.all([listCampers({ bedroom: b._id }), listStaff()]);
  const staff = allStaff.filter((s) => s.bedroom === b._id);
  return c.json({
    bedroom: serializeBedroom(b, { staff: staff.length, campers: campers.length }),
    campers: serializeCamperList(campers, scope),
    staff: serializeStaffList(staff, scope),
  });
});

// ── write: admin or organizer ──────────────────────────────────────────────────────

bedrooms.use("/*", requireManager);

/** POST /api/bedrooms  { name, group, bunkBeds?, singleBeds?, notes? } */
bedrooms.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const data = result.patch as BedroomData;

  if (bedroomCapacity(data) === 0) {
    return fail(c, "CAPACITY_INVALID", "O quarto precisa ter ao menos uma cama.");
  }
  if (await findBedroomByName(data.name)) {
    return fail(c, "NAME_DUPLICATE", `Já existe um quarto "${data.name}".`, 409);
  }

  const created = await insertBedroom(data);
  publish("bedrooms");
  return c.json({ bedroom: serializeBedroom(created) }, 201);
});

/** PUT /api/bedrooms/:id — partial update. */
bedrooms.put("/:id", async (c) => {
  const existing = await findBedroomById(c.req.param("id"));
  if (!existing) return fail(c, "BEDROOM_NOT_FOUND", "Quarto não encontrado.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = buildPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);

  const merged = { ...existing, ...result.patch };
  if (bedroomCapacity(merged) === 0) {
    return fail(c, "CAPACITY_INVALID", "O quarto precisa ter ao menos uma cama.");
  }
  if (result.patch.name && result.patch.name !== existing.name) {
    const clash = await findBedroomByName(result.patch.name);
    if (clash && clash._id !== existing._id) {
      return fail(c, "NAME_DUPLICATE", `Já existe um quarto "${result.patch.name}".`, 409);
    }
  }

  const updated = await updateBedroom(existing._id, result.patch);
  if (result.patch.group && result.patch.group !== existing.group) {
    if (await applyBedroomGroupToOccupants(existing._id, result.patch.group)) publish("campers", "staff");
  }
  const occ = await occupancy();
  publish("bedrooms");
  return c.json({ bedroom: serializeBedroom(updated!, occ.get(updated!._id)) });
});

/** One team member's placement in the bulk apply. */
interface StaffPlacement {
  id: string;
  bedroom: string | null;
  roomRole: RoomRole;
}

/** One kid's placement in the bulk apply. */
interface CamperPlacement {
  id: string;
  bedroom: string | null;
  caretakerId: string | null;
}

function parsePlacement(v: unknown): { id: string; bedroom: unknown; roomRole: unknown; caretakerId: unknown } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" ? { id: o.id, bedroom: o.bedroom, roomRole: o.roomRole, caretakerId: o.caretakerId } : null;
}


/** null-ish bedroom must reach us as null (""/undefined = no room) */
const asRoom = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : v as string);

/**
 * POST /api/bedrooms/apply  { staff?: [{id, bedroom, roomRole}], campers?: [{id, bedroom, caretakerId}] }
 * Applies the WHOLE "montar quartos" delta at once — every staff placement
 * (room + role) and every kid placement (room + líder) — then texts each
 * person concerned with ONE SMS summarising everything that changed for them
 * (see notifyRoomsApplied). Sent by the Concluir button: the admin edits a
 * local draft and only this call touches the server. Capacities are not
 * enforced here on purpose — a room's beds are a comfortable size, not a hard
 * limit; the admin decides who sleeps where (same rule as the board).
 */
bedrooms.post("/apply", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const rawStaff = Array.isArray(body.staff) ? body.staff : [];
  const rawCampers = Array.isArray(body.campers) ? body.campers : [];
  if (rawStaff.length === 0 && rawCampers.length === 0) return fail(c, "EMPTY", "Nada para aplicar.");
  if (rawStaff.length + rawCampers.length > 1000) return fail(c, "TOO_MANY", "Muitas mudanças de uma vez só.");

  const isPlacement = (m: ReturnType<typeof parsePlacement>): m is NonNullable<typeof m> => !!m;
  const staffMoves = rawStaff.map(parsePlacement).filter(isPlacement);
  const camperMoves = rawCampers.map(parsePlacement).filter(isPlacement);
  if (staffMoves.length !== rawStaff.length || camperMoves.length !== rawCampers.length) return fail(c, "BODY_INVALID", "Mudança inválida: envie { id, quarto, função }.");

  const [staffAll, campersAll, rooms] = await Promise.all([listStaff(), listCampers(), listBedrooms()]);
  const roomById = new Map(rooms.map((b) => [b._id, b]));
  const staffById = new Map(staffAll.map((s) => [s._id, s]));
  const camperById = new Map(campersAll.map((k) => [k._id, k]));

  // ── validate the placements against the FINAL state they produce ──
  const finalStaff = new Map(staffAll.map((s) => [s._id, { ...s }]));
  for (const m of staffMoves) {
    const s = staffById.get(m.id);
    if (!s) return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
    const bedroom = asRoom(m.bedroom);
    if (bedroom && !roomById.has(bedroom)) return fail(c, "BEDROOM_INVALID", "Quarto não encontrado.", 404);
    const roomRole = m.roomRole === undefined ? s.roomRole : m.roomRole;
    if (!ROOM_ROLES.includes(roomRole as RoomRole)) return fail(c, "ROOM_ROLE_INVALID", "Função no quarto deve ser líder ou auxiliar.");
    const f = finalStaff.get(m.id)!;
    f.bedroom = bedroom;
    f.roomRole = roomRole as RoomRole;
  }

  for (const m of camperMoves) {
    const k = camperById.get(m.id);
    if (!k) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
    const bedroom = asRoom(m.bedroom);
    if (bedroom && !roomById.has(bedroom)) return fail(c, "BEDROOM_INVALID", "Quarto não encontrado.", 404);
    const caretakerId = asRoom(m.caretakerId);
    if (bedroom) {
      const room = roomById.get(bedroom)!;
      if (room.group === "staff") return fail(c, "BEDROOM_INVALID", "Uma criança não dorme em quarto da equipe.");
      const wing = room.group === "girls" ? "F" : "M";
      if (k.sex && k.sex !== wing) {
        return fail(c, "SEX_INVALID", `Uma das crianças não pode dormir na ala ${room.group === "girls" ? "das meninas" : "dos meninos"}.`);
      }
    }
    if (caretakerId) {
      const caretaker = finalStaff.get(caretakerId);
      if (!caretaker) return fail(c, "CARETAKER_INVALID", "Líder não encontrado.", 404);
      if (caretaker.bedroom !== bedroom) return fail(c, "CARETAKER_INVALID", "O líder escolhido não dorme neste quarto.");
      if (caretaker.roomRole !== "caretaker") return fail(c, "CARETAKER_INVALID", "A pessoa escolhida é auxiliar neste quarto, não líder.");
    }
  }

  // ── apply: staff first, then the kids (their líder must already be in place) ──
  let staffApplied = 0;
  let roleChanged = false;
  for (const m of staffMoves) {
    const s = staffById.get(m.id)!;
    const bedroom = asRoom(m.bedroom);
    const roomRole = (m.roomRole === undefined ? s.roomRole : m.roomRole) as RoomRole;
    if (bedroom === s.bedroom && roomRole === s.roomRole) continue; // no-op
    if (roomRole !== s.roomRole) roleChanged = true;
    // the girls / boys wing decides the (derived) sex
    await updateStaff(m.id, { bedroom, roomRole, ...(bedroom !== s.bedroom ? { sex: sexOfGroup(bedroom ? roomById.get(bedroom)?.group : null) } : {}) });
    staffApplied++;
  }

  let campersApplied = 0;
  for (const m of camperMoves) {
    const k = camperById.get(m.id)!;
    const bedroom = asRoom(m.bedroom);
    const caretakerId = asRoom(m.caretakerId);
    if (bedroom === k.bedroom && caretakerId === k.caretakerId) continue; // no-op
    await updateCamper(m.id, { bedroom, caretakerId, ...(bedroom !== k.bedroom ? { bed: null, sex: sexOfGroup(bedroom ? roomById.get(bedroom)?.group : null) } : {}) });
    campersApplied++;
  }

  // whoever LOST their líder through the apply is an orphan now (a líder who
  // left the room, or stopped being one) — same rule as the single writes,
  // re-checked against the state the delta itself just produced
  const afterStaffList = await listStaff();
  const afterStaffById = new Map(afterStaffList.map((s) => [s._id, s]));
  for (const k of await listCampers()) {
    if (!k.caretakerId) continue;
    const now = afterStaffById.get(k.caretakerId);
    if (!now || now.bedroom !== k.bedroom || now.roomRole !== "caretaker") await updateCamper(k._id, { caretakerId: null });
  }
  const afterCampers = await listCampers();
  publish("staff", "bedrooms", "campers", ...(roleChanged ? (["instructions", "preparation"] as const) : []));
  // the admin may turn the SMS off for this apply (the Concluir dialog toggle)
  if (body.notify !== false) void notifyRoomsApplied({ staff: staffAll, campers: campersAll }, { staff: afterStaffList, campers: afterCampers });
  return c.json({ applied: { staff: staffApplied, campers: campersApplied } });
});

/**
 * POST /api/bedrooms/apply/preview  { staff?, campers? } — same body as apply.
 * Read-only: validates nothing (the board already did) and simulates the delta
 * in memory to return exactly who would be texted and the SMS each would get
 * (roomsAppliedMessages), so the Concluir dialog can show the real messages.
 */
bedrooms.post("/apply/preview", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ messages: [] });
  const staffMoves = (Array.isArray(body.staff) ? body.staff : []).map(parsePlacement).filter((m): m is NonNullable<typeof m> => !!m);
  const camperMoves = (Array.isArray(body.campers) ? body.campers : []).map(parsePlacement).filter((m): m is NonNullable<typeof m> => !!m);

  const [staffAll, campersAll, rooms, settings] = await Promise.all([listStaff(), listCampers(), listBedrooms(), getSettings()]);

  // simulate the after-state in memory (only the fields notifications look at)
  const afterStaff = staffAll.map((s) => ({ ...s }));
  const afterStaffById = new Map(afterStaff.map((s) => [s._id, s]));
  for (const m of staffMoves) {
    const s = afterStaffById.get(m.id);
    if (s) { s.bedroom = asRoom(m.bedroom); s.roomRole = (m.roomRole === undefined ? s.roomRole : m.roomRole) as RoomRole; }
  }
  const afterCampers = campersAll.map((k) => ({ ...k }));
  const afterCamperById = new Map(afterCampers.map((k) => [k._id, k]));
  for (const m of camperMoves) {
    const k = afterCamperById.get(m.id);
    if (k) { k.bedroom = asRoom(m.bedroom); k.caretakerId = asRoom(m.caretakerId); }
  }
  // same orphan pass as the real apply, in memory
  for (const k of afterCampers) {
    if (!k.caretakerId) continue;
    const now = afterStaffById.get(k.caretakerId);
    if (!now || now.bedroom !== k.bedroom || now.roomRole !== "caretaker") k.caretakerId = null;
  }

  const kidNames = new Map([...(await namesOf(afterCampers.map((k) => k._id)))].map(([id, n]) => [id, firstName(n.name)]));
  const messages = roomsAppliedMessages({ staff: staffAll, campers: campersAll }, { staff: afterStaff, campers: afterCampers }, settings, rooms, kidNames);
  return c.json({ messages, smsEnabled: true });
});

/** DELETE /api/bedrooms/:id — refused while someone is assigned to it. */
bedrooms.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await findBedroomById(id);
  if (!existing) return fail(c, "BEDROOM_NOT_FOUND", "Quarto não encontrado.", 404);

  const o = (await occupancy()).get(id) ?? NONE;
  const occ = o.staff + o.campers;
  if (occ > 0) {
    return fail(
      c,
      "BEDROOM_IN_USE",
      `Este quarto tem ${occ} pessoa${occ > 1 ? "s" : ""} alocada${occ > 1 ? "s" : ""}. Mova-as antes de excluir.`,
      409,
    );
  }

  await deleteBedroom(id);
  publish("bedrooms");
  return c.json({ success: true });
});

export default bedrooms;
