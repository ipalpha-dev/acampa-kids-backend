import { campEditionId } from "./acting";
import { currentCampId } from "./campContext";
import { coreClient } from "./ipalpha";
import type { Membership } from "./ipalpha/coreClient";
import { COORDINATION_ROLE, PARTICIPANT_ROLE, type CoreRole } from "../types";

/**
 * Project memberships read through the app client (`projects:app-members`,
 * CONTRACTS §11). Roles and family links live in core; Acampa only asks.
 *
 * The kids of a responsável are re-read on every scope resolution, which the
 * realtime hub does per viewer on each publish — a tiny in-memory memo
 * (person ids only, 20 s) keeps that from turning into a burst of identical
 * calls. Decision 70 allows id relations in apps (personId ↔ personId), never
 * names or other person data: the memo holds `responsável id → kid ids` and
 * nothing else, lives only in this process and expires after 20 s (so a link
 * removed in core stops granting access within 20 s at most).
 */
const MEMO_MS = 20_000;
const memo = new Map<string, { ids: string[]; at: number }>();

async function allPages(query: Parameters<ReturnType<typeof coreClient>["listMembers"]>[0]): Promise<Membership[]> {
  const out: Membership[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await coreClient().listMembers({ ...query, cursor, limit: 200 });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

/** Every member of `role` in the current camp's edition (project-wide roles: editionId "none"). */
export async function membersOf(role: CoreRole, campId: string = currentCampId()): Promise<Membership[]> {
  const editionId = role === COORDINATION_ROLE ? "none" : await campEditionId(campId);
  if (!editionId) return [];
  return allPages({ role, editionId });
}

/** Person ids of the kids (`participante` of the camp's edition) naming `personId` as involved responsável. */
export async function kidsOfResponsible(personId: string, campId: string = currentCampId()): Promise<string[]> {
  const key = `${campId}|${personId}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.ids;
  const editionId = await campEditionId(campId);
  if (!editionId) return [];
  // core filters by `involvedPersonId`; we still check every row names THIS person as responsável
  // (never trust a filter we cannot see — a row without them must not open a kid to this parent)
  const rows = await allPages({ role: PARTICIPANT_ROLE, editionId, involvedPersonId: personId });
  const ids = [...new Set(rows.filter((m) => m.role === PARTICIPANT_ROLE && m.involved.some((i) => i.personId === personId && i.purpose === "responsible")).map((m) => m.personId))];
  if (memo.size > 5000) memo.clear();
  memo.set(key, { ids, at: Date.now() });
  return ids;
}

/** The responsáveis (involved) of the given kids, by kid. */
export async function responsiblesOf(kidIds: string[], campId: string = currentCampId()): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (kidIds.length === 0) return out;
  const editionId = await campEditionId(campId);
  if (!editionId) return out;
  const wanted = new Set(kidIds);
  for (const m of await allPages({ role: PARTICIPANT_ROLE, editionId })) {
    if (!wanted.has(m.personId)) continue;
    out.set(m.personId, [...new Set([...(out.get(m.personId) ?? []), ...m.involved.filter((i) => i.purpose === "responsible").map((i) => i.personId)])]);
  }
  return out;
}

/** Is `role` still a live role of `personId` (that edition's row or a project-wide row)? Used on role switch (§15). */
export async function holdsRole(personId: string, role: CoreRole, campId: string = currentCampId()): Promise<boolean> {
  const editionId = role === COORDINATION_ROLE ? "none" : await campEditionId(campId);
  if (!editionId) return false;
  const rows = await allPages({ personId, role, editionId });
  return rows.some((m) => m.personId === personId && m.role === role);
}

/**
 * The live roles `personId` holds IN the camp's edition (edition rows only —
 * project-wide roles do not make someone a kid or a team member of a camp).
 * Read fresh (no memo): used right before a participant row is created.
 */
export async function editionRolesOf(personId: string, campId: string = currentCampId()): Promise<CoreRole[]> {
  const editionId = await campEditionId(campId);
  if (!editionId) return [];
  const rows = await allPages({ personId, editionId });
  return [...new Set(rows.filter((m) => m.personId === personId && m.editionId === editionId).map((m) => m.role))];
}

/** tests only */
export function clearMembersMemo(): void {
  memo.clear();
}
