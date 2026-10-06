import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { findCamperById } from "../models/campers";
import { insertOccurrence, listOccurrences, occurrencesForGroup } from "../models/occurrences";
import { findStaffById } from "../models/staff";
import { cleanHtml } from "../services/html";
import { notifyOccurrence } from "../services/notify";
import { publish } from "../services/realtime";
import { resolveScope, viewerOccurrenceGroup } from "../services/scope";
import type { Occurrence, OccurrenceGroup } from "../types";

type Env = { Variables: AuthVariables };

const occurrences = new Hono<Env>();
const DESCRIPTION_MAX = 400_000;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeOccurrence(occurrence: Occurrence) {
  return {
    id: occurrence._id,
    campers: occurrence.campers,
    staff: occurrence.staff,
    description: occurrence.description,
    /** person ids (names via POST /api/people/names) */
    createdBy: { personId: occurrence.createdByPersonId, role: occurrence.createdByRole, group: occurrence.createdByGroup },
    createdAt: occurrence.createdAt,
  };
}

async function occurrenceAccess(c: Context<Env, string>): Promise<OccurrenceGroup | null> {
  const role = c.get("activeRole");
  if (role === "admin") return "admin";
  if (role !== "staff") return null;
  return viewerOccurrenceGroup(await resolveScope(c.get("user")));
}

function parseIds(value: unknown, label: string): string[] | { error: string } {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return { error: `${label} inválido.` };
  const ids = [...new Set((value as string[]).map((id) => id.trim()).filter(Boolean))];
  if (ids.length > 100) return { error: `${label} tem pessoas demais.` };
  return ids;
}

/** The involved people must be this camp's participants; stored as person ids only. */
async function resolvePeople(ids: string[], kind: "camper" | "staff"): Promise<string[] | { error: string }> {
  const records = await Promise.all(ids.map((id) => (kind === "camper" ? findCamperById(id) : findStaffById(id))));
  if (records.some((record) => !record)) return { error: `${kind === "camper" ? "Acampante" : "Pessoa da equipe"} não encontrado(a).` };
  return records.map((record) => record!._id);
}

occurrences.use("*", requireAuth);

/** Admin sees every occurrence; organizers and medical staff only the records their group created. */
occurrences.get("/", async (c) => {
  const group = await occurrenceAccess(c);
  if (!group) return fail(c, "FORBIDDEN", "Só a administração e a equipe médica podem ver ocorrências.", 403);
  const visible = await occurrencesForGroup(await listOccurrences(), group);
  return c.json({ occurrences: visible.map(serializeOccurrence) });
});

/** Creates a permanent occurrence. Stamped with the author's group so peers can read it. */
occurrences.post("/", async (c) => {
  const group = await occurrenceAccess(c);
  if (!group) return fail(c, "FORBIDDEN", "Só a administração e a equipe médica podem criar ocorrências.", 403);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const camperIds = parseIds(body.camperIds, "Lista de acampantes");
  if (!Array.isArray(camperIds)) return fail(c, "CAMPERS_INVALID", camperIds.error);
  const staffIds = parseIds(body.staffIds, "Lista da equipe");
  if (!Array.isArray(staffIds)) return fail(c, "STAFF_INVALID", staffIds.error);

  const description = cleanHtml(body.description, DESCRIPTION_MAX);
  if (description === null) return fail(c, "DESCRIPTION_INVALID", "A descrição é inválida ou muito longa.");
  if (!description) return fail(c, "DESCRIPTION_REQUIRED", "Descreva o que aconteceu.");

  const [campers, staff] = await Promise.all([resolvePeople(camperIds, "camper"), resolvePeople(staffIds, "staff")]);
  if (!Array.isArray(campers)) return fail(c, "CAMPERS_INVALID", campers.error, 404);
  if (!Array.isArray(staff)) return fail(c, "STAFF_INVALID", staff.error, 404);

  const user = c.get("user");
  const created = await insertOccurrence({ campers, staff, description, createdByPersonId: user.id, createdByRole: user.coreRole, createdByGroup: group });
  publish("occurrences");
  void notifyOccurrence(created);
  return c.json({ occurrence: serializeOccurrence(created) }, 201);
});

export default occurrences;
