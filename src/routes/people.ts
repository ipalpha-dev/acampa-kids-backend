import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireAdmin, requireManager } from "../middleware/roles";
import { listCampers } from "../models/campers";
import { listStaff } from "../models/staff";
import { getSettings } from "../models/settings";
import { countHealthQueue, dropHealthQueueItem, listHealthQueue } from "../models/healthQueue";
import { actingToken, coordinationToken } from "../services/acting";
import { coreClient } from "../services/ipalpha";
import { NAMES_BATCH_MAX, PERSONS_RESOURCE } from "../services/ipalpha/coreClient";
import { mergeHealth, namesOf, readHealth, writeHealth } from "../services/people";
import { healthToCore } from "../services/coreRegistration";
import { IpalphaRejected } from "../services/ipalpha/coreClient";
import { EMPTY_HEALTH } from "../types";
import { camperVisibility, resolveScope, staffVisibility } from "../services/scope";
import { publish } from "../services/realtime";
import { PARTICIPANT_ROLE, RESPONSIBLE_ROLE, TEAM_ROLE } from "../types";

/**
 * /api/people — person data AT USE (CONTRACTS §15), never stored:
 *
 *   POST /names {personIds ≤ 200}        names of people the viewer may know (app client, paged by the caller)
 *   GET  /search?role&q&cursor           project members (coordenação / organização — to add someone to the camp)
 *   GET  /health-lists                   the church health option lists (labels for allergies / conditions)
 *   GET  /:personId/data/:kind           one data kind with the ACTING role token (persons-api role rules decide; logged)
 *   PATCH /:personId/data/:kind          write one data kind with the acting token (managers)
 *   GET  /health-queue                   how many AI health results wait to be written (coordenação)
 *   POST /health-queue/flush             write them to persons-api with the coordenação token
 */
const people = new Hono<{ Variables: AuthVariables }>();

const KINDS = new Set(["phone", "email", "document", "address", "medical", "school", "emergencyContact", "churchRelationship"]);

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

/** Person ids the viewer may know about: managers any participant; others their scope + themselves + the parents' contacts. */
async function knownIds(c: Context<{ Variables: AuthVariables }>): Promise<{ all: boolean; ids: Set<string> }> {
  const user = c.get("user");
  const scope = await resolveScope(user);
  if (scope.all) return { all: true, ids: new Set() };
  const [kids, team, settings] = await Promise.all([listCampers(), listStaff(), getSettings()]);
  const ids = new Set<string>([user.personId]);
  for (const k of kids) if (camperVisibility(scope, k) !== "none") ids.add(k._id);
  for (const s of team) if (staffVisibility(scope, s) !== "none") ids.add(s._id);
  if (!scope.all && scope.parentKids.length) for (const p of settings.parentContacts) ids.add(p.personId);
  return { all: false, ids };
}

people.use("*", requireAuth);

people.post("/names", async (c) => {
  const body = await c.req.json<{ personIds?: unknown }>().catch(() => null);
  const ids = Array.isArray(body?.personIds) ? [...new Set(body.personIds.filter((x): x is string => typeof x === "string" && !!x))] : [];
  if (ids.length === 0) return c.json({ items: [] });
  if (ids.length > NAMES_BATCH_MAX) return fail(c, "TOO_MANY", `Peça no máximo ${NAMES_BATCH_MAX} nomes por vez.`);
  const known = await knownIds(c);
  const allowed = known.all ? ids : ids.filter((id) => known.ids.has(id));
  const names = await namesOf(allowed);
  return c.json({ items: allowed.filter((id) => names.has(id)).map((id) => ({ personId: id, name: names.get(id)!.name, nickname: names.get(id)!.nickname })) });
});

people.get("/search", requireManager, async (c) => {
  const role = c.req.query("role") ?? PARTICIPANT_ROLE;
  if (![PARTICIPANT_ROLE, TEAM_ROLE, RESPONSIBLE_ROLE].includes(role)) return fail(c, "ROLE_INVALID", "Papel inválido.");
  const page = await coreClient().listPeople(actingToken(c, PERSONS_RESOURCE), { role, q: c.req.query("q") || undefined, cursor: c.req.query("cursor") || undefined, limit: 50 });
  return c.json({ items: page.items.map((p) => ({ personId: p.personId, name: p.name, nickname: p.nickname })), nextCursor: page.nextCursor });
});

people.get("/health-lists", async (c) => c.json({ lists: await coreClient().healthLists(actingToken(c, PERSONS_RESOURCE)) }));

people.get("/health-queue", requireAdmin, async (c) => c.json({ pending: await countHealthQueue() }));

/**
 * Writes the pending AI health results with the coordenação token: Acampa's
 * import option ids are mapped onto the church health lists, then merged over
 * the person's current block (never erasing what is there).
 */
people.post("/health-queue/flush", requireAdmin, async (c) => {
  const token = coordinationToken(c.get("session"), PERSONS_RESOURCE);
  if (!token) return fail(c, "COORDINATION_REQUIRED", "Só a coordenação grava estas informações.", 403);
  let written = 0;
  let refused = 0;
  const lists = await coreClient().healthLists(token);
  for (const item of await listHealthQueue()) {
    try {
      const current = (await readHealth(token, item.personId)) ?? { ...EMPTY_HEALTH };
      const patch = mergeHealth(current, await healthToCore(token, item.patch, lists));
      if (Object.keys(patch).length) await writeHealth(token, item.personId, patch, current);
      written++;
      await dropHealthQueueItem(item.personId);
    } catch (err) {
      if (!(err instanceof IpalphaRejected) || err.status === 401) throw err;
      // core refused this person's write (role rules / validation): dropped, counted
      refused++;
      await dropHealthQueueItem(item.personId);
    }
  }
  if (written) publish("campers", "staff");
  return c.json({ written, refused, pending: await countHealthQueue() });
});

people.get("/:personId/data/:kind", async (c) => {
  const { personId, kind } = c.req.param();
  if (!KINDS.has(kind)) return fail(c, "KIND_INVALID", "Tipo de dado inválido.");
  const known = await knownIds(c);
  if (!known.all && !known.ids.has(personId)) return fail(c, "PERSON_NOT_FOUND", "Pessoa não encontrada.", 404);
  c.header("Cache-Control", "no-store");
  return c.json({ personId, kind, data: await coreClient().readData(actingToken(c, PERSONS_RESOURCE), personId, kind) });
});

people.patch("/:personId/data/:kind", requireManager, async (c) => {
  const { personId, kind } = c.req.param();
  if (!KINDS.has(kind)) return fail(c, "KIND_INVALID", "Tipo de dado inválido.");
  const body = await c.req.json<unknown>().catch(() => undefined);
  if (body === undefined) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  return c.json({ personId, kind, data: await coreClient().writeData(actingToken(c, PERSONS_RESOURCE), personId, kind, body) });
});

export default people;
