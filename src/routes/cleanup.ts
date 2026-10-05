import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { deleteFile } from "../models/files";
import {
  CLEANUP_GROUPS,
  STAFF_KEEP_GROUPS,
  countNotificationMarks,
  resetCampSettings,
  wipeBedrooms,
  wipeCampers,
  wipeDocs,
  wipeGallery,
  wipeMedications,
  wipeOccurrences,
  wipeSchedule,
  wipeScores,
  wipeStaff,
  wipeTeams,
  wipeTransports,
  wipeNotices,
  wipeWelcomes,
  type CleanupGroup,
  type StaffKeepGroup,
} from "../models/cleanup";
import { publish } from "../services/realtime";
import type { Collection } from "../services/realtime";
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
 * Configurações → Limpeza (ADMIN ONLY — not the organizers): wipes one block
 * of the camp at a time so the next year's camp starts from a clean base.
 *
 *   GET  /api/cleanup/marks      — how many "already sent" notification marks
 *   POST /api/cleanup/:group     — wipe one block ("all" = every block)
 *        { keep?: StaffKeepGroup[] }  — admin lists whose people survive the
 *        Equipe wipe (the list itself is kept too)
 *        { roles?: boolean }          — the Programação block also deletes the
 *        funções with their instructions / preparation (off by default)
 *
 * The other counts the page shows come from the realtime collections.
 * Nothing is reversible; the confirmation lives in the UI.
 */
const cleanup = new Hono<Env>();

/** Which realtime collections each block changes (its own + the references it clears). */
const TOUCHES: Record<CleanupGroup, Collection[]> = {
  campers: ["campers", "staff", "bedrooms", "scores", "medications"],
  staff: ["staff", "campers", "bedrooms", "teams", "events", "settings"],
  bedrooms: ["bedrooms", "campers", "staff"],
  transports: ["transports", "campers", "staff", "settings"],
  teams: ["teams", "campers", "staff", "scores"],
  schedule: ["events", "roles", "gallery", "scores"],
  docs: ["instructions", "preparation"],
  occurrences: ["occurrences"],
  medications: ["medications"],
  scores: ["scores"],
  gallery: ["gallery"],
  welcomes: ["staff"],
  notices: ["staff", "campers", "settings"],
};

async function wipe(group: CleanupGroup, keep: StaffKeepGroup[], roles: boolean): Promise<number> {
  switch (group) {
    case "campers":
      return wipeCampers();
    case "staff":
      return wipeStaff(keep);
    case "bedrooms":
      return wipeBedrooms();
    case "transports":
      return wipeTransports();
    case "teams":
      return wipeTeams();
    case "schedule":
      return wipeSchedule(roles);
    case "docs":
      return wipeDocs();
    case "occurrences":
      return wipeOccurrences();
    case "medications":
      return wipeMedications();
    case "scores":
      return wipeScores();
    case "welcomes":
      return wipeWelcomes();
    case "notices":
      return wipeNotices();
    case "gallery": {
      const { count, fileIds } = await wipeGallery();
      await Promise.all(fileIds.map((id) => deleteFile(id)));
      return count;
    }
  }
}

cleanup.use("*", requireAuth, requireAdmin);

cleanup.get("/marks", async (c) => c.json(await countNotificationMarks()));

cleanup.post("/:group", async (c) => {
  const group = c.req.param("group");
  const all = group === "all";
  if (!all && !CLEANUP_GROUPS.includes(group as CleanupGroup)) {
    return c.json({ error: { code: "GROUP_UNKNOWN", message: "Não sei limpar isso." } }, 400);
  }

  const body = await c.req.json<{ keep?: unknown; roles?: unknown }>().catch(() => null);
  const asked = Array.isArray(body?.keep) ? body.keep : [];
  const keep = STAFF_KEEP_GROUPS.filter((g) => asked.includes(g));
  const roles = body?.roles === true;

  // order matters: the blocks that only clear references run before the ones that own them
  const groups: CleanupGroup[] = all
    ? ["gallery", "occurrences", "medications", "scores", "schedule", "campers", "staff", "teams", "bedrooms", "transports", "welcomes", "notices"]
    : [group as CleanupGroup];
  const removed: Partial<Record<CleanupGroup, number>> = {};
  for (const g of groups) removed[g] = await wipe(g, keep, roles);
  if (all) await resetCampSettings();

  const touched = new Set<Collection>(groups.flatMap((g) => TOUCHES[g]));
  if (all) touched.add("settings");
  publish(...touched);
  console.log(`🧹 cleanup (${all ? "tudo" : group})${keep.length ? ` (mantendo ${keep.join(", ")})` : ""}${roles ? " (+funções)" : ""}: ${Object.entries(removed).map(([g, n]) => `${g} ${n}`).join(", ")}`);

  return c.json({ removed });
});

export default cleanup;
