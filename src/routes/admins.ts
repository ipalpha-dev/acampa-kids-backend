import { Hono } from "hono";
import { config } from "../config";
import { isSuperAdmin, requireAuth, superAdminIds, type AuthVariables } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { membersOf } from "../services/members";
import { namesOf } from "../services/people";
import { COORDINATION_ROLE } from "../types";

/**
 * GET /api/admins — the coordenação: every person holding the project-wide
 * `coordenacao` role in projects-api (+ the SUPER_ADMIN_PERSON_IDS owners),
 * names read live. Granting / removing the role happens in Mordomia (projects
 * memberships) — Acampa no longer creates admins or hands the camp over.
 */
const admins = new Hono<{ Variables: AuthVariables }>();

admins.get("/", requireAuth, requireAdmin, async (c) => {
  const ids = [...new Set([...(await membersOf(COORDINATION_ROLE)).map((m) => m.personId), ...superAdminIds()])];
  const names = await namesOf(ids);
  return c.json({
    admins: ids.map((id) => ({ personId: id, name: names.get(id)?.name ?? "", superAdmin: isSuperAdmin(id) })),
    appUrl: config.appUrl,
  });
});

export default admins;
