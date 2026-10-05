import { Hono, type Context } from "hono";
import { requireAuth } from "../middleware/auth";
import { requireSuperAdmin } from "../middleware/roles";
import { countImportCache, wipeImportCache, wipeStaffImportCache } from "../models/cleanup";
import type { Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

/**
 * Configurações → Superusuário (SUPER_ADMIN_PERSON_IDS only): deployment-wide
 * housekeeping that isn't scoped to a single camp.
 *
 *   GET  /api/super/import-cache        — how many remembered import mappings
 *   POST /api/super/import-cache/staff  — wipe the staff import column cache
 *   POST /api/super/import-cache        — wipe the staff + camper import dictionary
 */
const superRoutes = new Hono<Env>();

superRoutes.use("*", requireAuth, requireSuperAdmin);

superRoutes.get("/import-cache", async (c: Context) => c.json(await countImportCache()));

superRoutes.post("/import-cache/staff", async (c: Context) => {
  const removed = await wipeStaffImportCache();
  console.log(`🧹 cleanup (staff-import-cache) by ${c.get("user").name}: ${removed} mapping(s)`);
  return c.json({ removed });
});

superRoutes.post("/import-cache", async (c: Context) => {
  const removed = await wipeImportCache();
  console.log(`🧹 cleanup (import-cache) by ${c.get("user").name}: ${removed} mapping(s)`);
  return c.json({ removed });
});

export default superRoutes;
