import { campEditionId, campEditionIdOrThrow, membersToken, roleToken } from "./acting";
import { currentCampId } from "./campContext";
import { coreClient } from "./ipalpha";
import { IpalphaRejected, IpalphaTokenRevoked, IpalphaUnavailable, PROJECTS_RESOURCE, type Membership } from "./ipalpha/coreClient";
import { currentViewer } from "./viewer";
import { COORDINATION_ROLE, PARTICIPANT_ROLE, RESPONSIBLE_ROLE, type CoreRole, type Session } from "../types";

/**
 * Project memberships read with the VIEWER's role tokens (services/viewer.ts). Roles and family links live in
 * core; Acampa only asks:
 *
 *   member lists      one role's memberships (ids + involvement), with the ACTING role's token only — core answers
 *                     when that role `seesPersonsOf` the listed role; a refusal (403) or no viewer at all (timers)
 *                     → an empty list, never a guess
 *   own roles         the person's own role token on the self read (`memberships/person/:me`)
 *   a parent's kids   the same self read: the memberships naming them as involved
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

type MembersQuery = Parameters<ReturnType<typeof coreClient>["listMembers"]>[1];

async function allPages(token: string, query: MembersQuery): Promise<Membership[]> {
  const out: Membership[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await coreClient().listMembers(token, { ...query, cursor, limit: 200 });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

/** null = refused (no token, or core said 403) */
async function listedOrNull(token: string | null, query: MembersQuery): Promise<Membership[] | null> {
  if (!token) return null;
  try {
    return await allPages(token, query);
  } catch (err) {
    if (err instanceof IpalphaRejected && err.status === 403) return null;
    throw err;
  }
}

async function listedWith(token: string | null, query: MembersQuery): Promise<Membership[]> {
  return (await listedOrNull(token, query)) ?? [];
}

function viewerListToken(): string | null {
  const session = currentViewer();
  return session ? membersToken(session) : null;
}

/** Every member of `role` in the current camp's edition (project-wide roles: editionId "none"). */
export async function membersOf(role: CoreRole, campId: string = currentCampId()): Promise<Membership[]> {
  const editionId = role === COORDINATION_ROLE ? "none" : await campEditionId(campId);
  if (!editionId) return [];
  return listedWith(viewerListToken(), { role, editionId });
}

/**
 * Person ids of the kids (`participante` of the camp's edition) naming `personId` as involved responsável — the
 * self read with that responsável's OWN token, so only their own session (the viewer) acting as responsável answers it.
 */
export async function kidsOfResponsible(personId: string, campId: string = currentCampId()): Promise<string[]> {
  const key = `${campId}|${personId}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.ids;
  const session = currentViewer();
  if (!session || session.personId !== personId || session.activeRole !== RESPONSIBLE_ROLE) return [];
  const editionId = await campEditionId(campId);
  if (!editionId) return [];
  const own = await coreClient().ownMemberships(roleToken(session, PROJECTS_RESOURCE), personId, editionId);
  const ids = [...new Set(own.involved.filter((m) => m.role === PARTICIPANT_ROLE && m.editionId === editionId).map((m) => m.personId))];
  if (memo.size > 5000) memo.clear();
  memo.set(key, { ids, at: Date.now() });
  return ids;
}

/**
 * Drops the memo of one responsável (every camp), so the next scope resolution reads core again — used when
 * projects-api shows they were just added to a kid's membership (a link request accepted, decision 86).
 */
export function forgetKidsOf(personId: string): void {
  for (const key of memo.keys()) if (key.endsWith(`|${personId}`)) memo.delete(key);
}

/**
 * The responsáveis of the given kids, by kid, as far as the viewer may see them: the kids' `participante` rows
 * (their `involved`) ∩ the edition's `responsavel` members the viewer's role may list (`seesPersonsOf`). `hidden` =
 * core refused one of the lists (the role does not see them) — never "no responsável". A responsável (acting as one)
 * refused the lists still gets themselves for their own kids.
 */
export async function responsiblesView(kidIds: string[], campId: string = currentCampId()): Promise<{ byKid: Map<string, string[]>; hidden: boolean }> {
  const byKid = new Map<string, string[]>();
  if (kidIds.length === 0) return { byKid, hidden: false };
  const editionId = await campEditionId(campId);
  const session = currentViewer();
  if (!editionId || !session) return { byKid, hidden: !session };
  const token = membersToken(session);
  const [kids, responsibles] = await Promise.all([listedOrNull(token, { role: PARTICIPANT_ROLE, editionId }), listedOrNull(token, { role: RESPONSIBLE_ROLE, editionId })]);
  if (!kids || !responsibles) {
    if (session.activeRole === RESPONSIBLE_ROLE) {
      const mine = new Set(await kidsOfResponsible(session.personId, campId));
      for (const id of kidIds) if (mine.has(id)) byKid.set(id, [session.personId]);
    }
    return { byKid, hidden: true };
  }
  const visible = new Set(responsibles.map((m) => m.personId));
  const wanted = new Set(kidIds);
  for (const m of kids) {
    if (!wanted.has(m.personId) || m.role !== PARTICIPANT_ROLE) continue;
    const ids = m.involved.filter((i) => i.purpose === "responsible" && visible.has(i.personId)).map((i) => i.personId);
    byKid.set(m.personId, [...new Set([...(byKid.get(m.personId) ?? []), ...ids])]);
  }
  return { byKid, hidden: false };
}

/** The responsáveis the viewer may see of the given kids, by kid (see `responsiblesView`). */
export async function responsiblesOf(kidIds: string[], campId: string = currentCampId()): Promise<Map<string, string[]>> {
  return (await responsiblesView(kidIds, campId)).byKid;
}

const EDITION_REASONS = new Set(["unknownEdition", "editionMismatch", "editionNotUsable", "editionArchived"]);

/**
 * A core refusal while checking a session's role, as what the session must do: Acampa unlinked from the project
 * (`appMismatch`) or — for a per-edition role — an edition core no longer serves to Acampa are FINAL (the session ends,
 * the device wipes); coordenação keeps history camps, so an edition refusal is 503 for it. Anything else unchanged
 * (a core that cannot answer stays `IpalphaUnavailable` → 503, session kept).
 */
export function sessionRefusal(err: unknown, role: CoreRole, label: string): unknown {
  if (!(err instanceof IpalphaRejected)) return err;
  if (err.reason === "appMismatch") return new IpalphaTokenRevoked(`${label}: app unlinked`);
  if (EDITION_REASONS.has(err.reason)) return role === COORDINATION_ROLE ? new IpalphaUnavailable(`${label}: ${err.reason}`) : new IpalphaTokenRevoked(`${label}: ${err.reason}`);
  return err;
}

async function ownRows(token: string, role: CoreRole, personId: string, editionId?: string): Promise<Membership[]> {
  try {
    return (await coreClient().ownMemberships(token, personId, editionId)).memberships;
  } catch (err) {
    throw sessionRefusal(err, role, "memberships/own");
  }
}

/**
 * Is `role` still a live role of the session's person — that camp edition's row, or (coordenação) a project-wide
 * row or the camp edition's? Self read with that role's token (§15). A core that cannot answer throws
 * `IpalphaUnavailable` (503, session kept); a final refusal (`sessionRefusal`) ends the session.
 */
export async function holdsRole(session: Session, role: CoreRole, campId: string = currentCampId()): Promise<boolean> {
  const token = roleToken(session, PROJECTS_RESOURCE, role);
  if (role === COORDINATION_ROLE && (await ownRows(token, role, session.personId)).some((m) => m.role === role && !m.editionId)) return true;
  let editionId: string | null;
  try {
    editionId = await campEditionIdOrThrow(campId, session);
  } catch (err) {
    throw sessionRefusal(err, role, "camp edition");
  }
  // the editions were read and none of the camp's year serves Acampa any more: final for a per-edition role
  if (!editionId) throw role === COORDINATION_ROLE ? new IpalphaUnavailable("camp edition unknown") : new IpalphaTokenRevoked("camp edition not usable");
  return (await ownRows(token, role, session.personId, editionId)).some((m) => m.role === role && m.editionId === editionId);
}

/**
 * The live roles `personId` holds IN the camp's edition (edition rows only —
 * project-wide roles do not make someone a kid or a team member of a camp).
 * Read fresh (no memo): used right before a participant row is created. The viewer's own roles come from the
 * self read; anyone else's from a member list (coordenação).
 */
export async function editionRolesOf(personId: string, among: readonly CoreRole[], campId: string = currentCampId()): Promise<CoreRole[]> {
  return (await editionRolesKnown(personId, among, campId)) ?? [];
}

/**
 * Same, but null when it cannot be known (no edition, no viewer, core refused every list) — callers that must fail
 * closed. Another person's roles are asked one listed role at a time (`among`: the roles the caller cares about), as
 * core lists only roles the acting role sees; the refused ones count as not held.
 */
export async function editionRolesKnown(personId: string, among: readonly CoreRole[], campId: string = currentCampId()): Promise<CoreRole[] | null> {
  const editionId = await campEditionId(campId);
  if (!editionId) return null;
  const session = currentViewer();
  if (session?.personId === personId) {
    const own = (await coreClient().ownMemberships(roleToken(session, PROJECTS_RESOURCE), personId, editionId)).memberships;
    return [...new Set(own.filter((m) => m.editionId === editionId && among.includes(m.role)).map((m) => m.role))];
  }
  const token = viewerListToken();
  const lists = await Promise.all(among.map((role) => listedOrNull(token, { role, personId, editionId })));
  if (lists.every((rows) => rows === null)) return null;
  return [...new Set(lists.flatMap((rows) => rows ?? []).filter((m) => m.personId === personId && m.editionId === editionId && among.includes(m.role)).map((m) => m.role))];
}

/** tests only */
export function clearMembersMemo(): void {
  memo.clear();
}
