import { Hono, type Context } from "hono";
import { requireAuth } from "../middleware/auth";
import { requireOrganizer, requireRole } from "../middleware/roles";
import { deleteScoresOfTeam } from "../models/scores";
import { assignCamperGroupsAcrossTeams, deleteTeam, findTeamById, insertTeam, listTeams, TEAM_PALETTE, unlinkTeamEverywhere, updateTeam, type TeamData } from "../models/teams";
import { publish } from "../services/realtime";
import type { Role, SessionUser, Team } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const teams = new Hono<Env>();

const NAME_MAX = 60;

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeTeam(t: Team) {
  return {
    id: t._id,
    name: t.name,
    color: t.color,
    order: t.order,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;

async function buildPatch(body: Record<string, unknown>, partial: boolean): Promise<{ patch: Partial<TeamData> } | { code: string; message: string }> {
  const patch: Partial<TeamData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("name")) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > NAME_MAX) return { code: "NAME_INVALID", message: `Informe um nome com até ${NAME_MAX} caracteres.` };
    patch.name = name;
  }
  if (has("color")) {
    const color = typeof body.color === "string" ? body.color.trim().toLowerCase() : "";
    if (!COLOR_RE.test(color)) return { code: "COLOR_INVALID", message: "Escolha uma cor válida (#rrggbb)." };
    patch.color = color;
  }
  return { patch };
}

teams.use("*", requireAuth);

/** GET /api/teams — every logged-in team member / admin (names + colours are public inside the app). */
teams.get("/", requireRole("admin", "staff", "parent"), async (c) => c.json({ teams: (await listTeams()).map(serializeTeam) }));

// ── write: admin or organizer ──────────────────────────────────────────────────────

teams.use("/*", requireOrganizer);

/** POST /api/teams  { name, color? } */
teams.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const all = await listTeams();
  if (body.color === undefined) body.color = TEAM_PALETTE[all.length % TEAM_PALETTE.length];
  const result = await buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const data = result.patch as TeamData;
  if (all.some((t) => t.name.localeCompare(data.name, "pt-BR", { sensitivity: "base" }) === 0)) return fail(c, "NAME_DUPLICATE", "Já existe um time com este nome.", 409);
  data.order = all.length ? Math.max(...all.map((t) => t.order)) + 1 : 0;
  const created = await insertTeam(data);
  publish("teams");
  return c.json({ team: serializeTeam(created) }, 201);
});

/** PUT /api/teams/reorder  { ids: string[] } */
teams.put("/reorder", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.ids) || body.ids.some((x) => typeof x !== "string")) return fail(c, "IDS_INVALID", "Envie { ids: string[] }.");
  const ids = body.ids as string[];
  const all = await listTeams();
  const known = new Set(all.map((t) => t._id));
  if (ids.length !== known.size || ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length) return fail(c, "IDS_INVALID", "A lista precisa conter cada time exatamente uma vez.");
  await Promise.all(ids.map((id, order) => updateTeam(id, { order })));
  publish("teams");
  return c.json({ teams: (await listTeams()).map(serializeTeam) });
});

/** POST /api/teams/auto-assign-campers — deals client-built groups evenly across every team. */
teams.post("/auto-assign-campers", async (c) => {
  const body = await c.req.json<{ groups?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.groups) || body.groups.some((group) => !Array.isArray(group) || group.some((id) => typeof id !== "string"))) return fail(c, "GROUPS_INVALID", "Os grupos de crianças são inválidos.");
  const all = await listTeams();
  if (all.length < 2) return fail(c, "TEAMS_REQUIRED", "Crie pelo menos dois times para fazer a distribuição.", 409);
  const { getDb } = await import("../db");
  const groups = body.groups as string[][];
  const flat = groups.flat();
  if (flat.some((id) => !id) || new Set(flat).size !== flat.length) return fail(c, "GROUPS_INVALID", "Os grupos de crianças são inválidos.");
  const db = await getDb();
  const existing = flat.length ? await db.collection("participants").countDocuments({ kind: "camper", personId: { $in: flat }, draft: { $ne: true } }) : 0;
  if (existing !== flat.length) return fail(c, "GROUPS_INVALID", "Uma criança não está mais disponível.", 409);
  const assigned = await assignCamperGroupsAcrossTeams(all.map((team) => team._id), groups);
  publish("campers");
  return c.json({ assigned });
});

/** PUT /api/teams/assignments — immediately moves one person or a visible group to a team (or no team). */
teams.put("/assignments", async (c) => {
  const body = await c.req.json<{ kind?: unknown; ids?: unknown; teamId?: unknown }>().catch(() => null);
  if (!body || (body.kind !== "camper" && body.kind !== "staff") || !Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((id) => typeof id !== "string") || (body.teamId !== null && typeof body.teamId !== "string")) return fail(c, "ASSIGNMENT_INVALID", "A distribuição é inválida.");
  const { getDb } = await import("../db");
  const ids = body.ids as string[];
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return fail(c, "ASSIGNMENT_INVALID", "As pessoas são inválidas.");
  if (body.teamId && !(await findTeamById(body.teamId))) return fail(c, "TEAM_NOT_FOUND", "Time não encontrado.", 404);
  const db = await getDb();
  const collection = "participants";
  const filter: Record<string, unknown> = { kind: body.kind === "camper" ? "camper" : "team", personId: { $in: ids }, draft: { $ne: true } };
  if (body.kind === "staff") filter.active = { $ne: false };
  const existing = await db.collection(collection).countDocuments(filter);
  if (existing !== ids.length) return fail(c, "PERSON_NOT_FOUND", "Uma pessoa não está mais disponível.", 404);
  await db.collection(collection).updateMany(filter, { $set: { team: body.teamId, updatedAt: new Date() } });
  publish(body.kind === "camper" ? "campers" : "staff");
  return c.json({ updated: ids.length });
});

/** PUT /api/teams/:id — partial update. */
teams.put("/:id", async (c) => {
  const existing = await findTeamById(c.req.param("id"));
  if (!existing) return fail(c, "TEAM_NOT_FOUND", "Time não encontrado.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = await buildPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  if (result.patch.name) {
    const all = await listTeams();
    if (all.some((t) => t._id !== existing._id && t.name.localeCompare(result.patch.name!, "pt-BR", { sensitivity: "base" }) === 0)) {
      return fail(c, "NAME_DUPLICATE", "Já existe um time com este nome.", 409);
    }
  }
  const updated = await updateTeam(existing._id, result.patch);
  publish("teams");
  return c.json({ team: serializeTeam(updated!) });
});

/** DELETE /api/teams/:id — unlinks every kid / staff member and drops the team's score lines. */
teams.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await deleteTeam(id);
  if (!ok) return fail(c, "TEAM_NOT_FOUND", "Time não encontrado.", 404);
  await Promise.all([unlinkTeamEverywhere(id), deleteScoresOfTeam(id)]);
  publish("teams", "campers", "staff", "scores");
  return c.json({ success: true });
});

export default teams;
