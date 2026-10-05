import { ObjectId } from "mongodb";
import { getDb } from "../db";
import { deleteCategory, findCategoryByKey } from "./categories";
import type { Team } from "../types";

const COLLECTION = "teams";

/** the category key the teams used to live under (before they got their own collection) */
const LEGACY_CATEGORY_KEY = "equipe";

/**
 * Default palette for migrated / new teams.
 * High-saturation, kid-nameable colours that stay distinct outdoors
 * (vermelho / laranja / amarelo / verde / ciano / azul / roxo / rosa / marrom / preto / lima).
 */
export const TEAM_PALETTE = [
  "#e30613", // vermelho
  "#ff6600", // laranja
  "#ffcc00", // amarelo
  "#a8e10c", // lima
  "#00a651", // verde
  "#00c2e0", // ciano
  "#0057b8", // azul
  "#6b2d8b", // roxo
  "#ff1493", // rosa
  "#8b4513", // marrom
  "#1a1a1a", // preto
];

function toTeam(doc: Record<string, unknown> | null): Team | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    draft: doc.draft === true,
    importId: (doc.importId as string) ?? undefined,
    name: doc.name as string,
    color: typeof doc.color === "string" ? doc.color : "#2a9d8f",
    order: (doc.order as number) ?? 0,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export type TeamData = Omit<Team, "_id" | "createdAt" | "updatedAt">;

export async function listTeams(includeDraft = false): Promise<Team[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find(includeDraft ? {} : { draft: { $ne: true } }).sort({ order: 1, name: 1 }).toArray();
  return docs.map((d) => toTeam(d as Record<string, unknown>)!);
}

export async function findTeamById(id: string): Promise<Team | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toTeam(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function insertTeam(data: TeamData): Promise<Team> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateTeam(id: string, patch: Partial<TeamData>): Promise<Team | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db.collection(COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toTeam(res as Record<string, unknown> | null);
}

export async function deleteTeam(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/** Unlinks every camper / staff member from the team (after it is deleted). */
export async function unlinkTeamEverywhere(teamId: string): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await Promise.all([
    db.collection("participants").updateMany({ team: teamId }, { $set: { team: null, updatedAt: now } }),
  ]);
}

/** Deals camper groups across teams, keeping each group together and balancing total children. */
export async function assignCamperGroupsAcrossTeams(teamIds: string[], groups: string[][]): Promise<number> {
  const db = await getDb();
  const shuffled = groups.filter((group) => group.length > 0).slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  shuffled.sort((a, b) => b.length - a.length);
  const totals = new Map(teamIds.map((id) => [id, 0]));
  const assignments = new Map<string, string>();
  for (const group of shuffled) {
    const teamId = teamIds.reduce((best, id) => (totals.get(id)! < totals.get(best)! ? id : best), teamIds[0]);
    for (const id of group) assignments.set(id, teamId);
    totals.set(teamId, totals.get(teamId)! + group.length);
  }
  if (!assignments.size) return 0;
  const now = new Date();
  await db.collection("participants").bulkWrite([...assignments].map(([id, team]) => ({
    // a hand-made distribution: remembered like any manual edit (decision 78)
    updateOne: { filter: { kind: "camper", personId: id, draft: { $ne: true } }, update: { $set: { team, updatedAt: now }, $addToSet: { importEdited: "team" } } },
  })));
  return assignments.size;
}

export async function ensureTeamIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ order: 1, name: 1 });
  await migrateLegacyTeamCategory();
}

/**
 * One-off migration, run at boot: the teams used to be the options of the
 * `equipe` category. Each option becomes a Team document with the SAME id
 * (the option ids are ObjectId strings), so every `Staff.team` /
 * `Camper.team` keeps pointing at the right team. Inactive options come along
 * too (people may still reference them). The category is then removed.
 */
async function migrateLegacyTeamCategory(): Promise<void> {
  const legacy = await findCategoryByKey(LEGACY_CATEGORY_KEY);
  if (!legacy) return;
  const db = await getDb();
  const existing = new Set((await listTeams()).map((t) => t._id));
  const now = new Date();
  let created = 0;
  for (const [i, o] of legacy.options.entries()) {
    if (existing.has(o.id) || !ObjectId.isValid(o.id)) continue;
    await db.collection(COLLECTION).insertOne({
      _id: new ObjectId(o.id),
      name: o.label,
      color: TEAM_PALETTE[i % TEAM_PALETTE.length],
      order: o.order,
      createdAt: now,
      updatedAt: now,
    });
    created++;
  }
  await deleteCategory(legacy._id);
  console.log(`🚩 teams: migrated ${created} team(s) from the "${LEGACY_CATEGORY_KEY}" category`);
}
