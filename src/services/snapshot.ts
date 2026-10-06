import { listBedrooms } from "../models/bedrooms";
import { listCampers } from "../models/campers";
import { listCategories } from "../models/categories";
import { listTransports } from "../models/transports";
import { listInstructions } from "../models/instructions";
import { listOccurrences, occurrencesForGroup } from "../models/occurrences";
import { listMedicationDoses } from "../models/medications";
import { listPrepSections } from "../models/preparation";
import { listEvents, listRoles } from "../models/schedule";
import { listStaff } from "../models/staff";
import { listTeams } from "../models/teams";
import { listScores } from "../models/scores";
import { listGalleryPhotos } from "../models/gallery";
import { serializeTeam } from "../routes/teams";
import { serializeScore } from "../routes/scores";
import { occupancy, serializeBedroom } from "../routes/bedrooms";
import { serializeCamperList } from "../routes/campers";
import { serializeCategory } from "../routes/categories";
import { serializeTransport } from "../routes/transports";
import { serializeInstruction } from "../routes/instructions";
import { serializeOccurrence } from "../routes/occurrences";
import { permittedMedicationIds, serializeMedicationDose } from "../routes/medications";
import { serializePrepListFor } from "../routes/preparation";
import { serializeEvent, serializeRole } from "../routes/schedule";
import { serializeSettings, serializeSettingsForManager } from "../routes/settings";
import { serializePhoto } from "../routes/gallery";
import { serializeStaffList } from "../routes/staff";
import { getSettings } from "../models/settings";
import type { Role } from "../types";
import { isSuperAdmin } from "../middleware/auth";
import { COLLECTIONS, type Collection, type Snapshot } from "./realtime";
import { canManageGallery, canSeeBedroom, canSeeDoc, canSeeScores, isParent, resolveScope, scopeEvent, scopeRoles, viewerOccurrenceGroup, type Viewer } from "./scope";

/**
 * Collections each role may read (mirrors the REST `requireRole` guards).
 * Staff/health staff get campers, staff and bedrooms FILTERED to their own
 * room, and the programme with only THEIR roles in each event (see ./scope.ts).
 */
const READABLE: Record<Role, readonly Collection[]> = {
  admin: COLLECTIONS,
  staff: ["campers", "staff", "bedrooms", "categories", "transports", "teams", "scores", "roles", "events", "preparation", "instructions", "occurrences", "medications", "gallery", "settings"],
  // parents: their own kids + rooms, the team of those rooms / important contacts (inside the window), the programme — and the PUBLISHED photos
  parent: ["campers", "staff", "bedrooms", "categories", "transports", "teams", "roles", "events", "preparation", "gallery", "settings"],
};

/**
 * Cache key for a built payload: the coordenação gets the same data
 * regardless of who they are; every other payload depends on the acting role
 * and the person (their room / their kids).
 */
export function snapshotKey(viewer: Viewer): string {
  return `${viewer.coreRole}|${viewer.personId}|${viewer.sessionId ?? ""}`;
}

/**
 * Reads and serializes `names` exactly like the REST endpoints do, honouring
 * the viewer's role and scope. PERSON DATA NEVER TRAVELS HERE (CONTRACTS
 * §15): `campers` / `staff` are camp-ops records keyed by person id; names
 * come from the paged REST lists (GET /api/campers, /api/staff) or
 * POST /api/people/names for the page being viewed; health only from REST
 * with the acting role token.
 */
export async function loadCollections(viewer: Viewer, names: readonly Collection[] = COLLECTIONS): Promise<Snapshot> {
  const role: Role = viewer.activeRole;
  const allowed = new Set(READABLE[role]);
  let wanted = names.filter((n) => allowed.has(n));
  const out: Snapshot = {};
  const scope = await resolveScope(viewer);
  // Occurrences: admin, organizers and the medical team. Each non-admin group
  // only receives the records it created (see viewerOccurrenceGroup).
  // Medication dose details require a health role and current core permission.
  if (!scope.all && !scope.medical) wanted = wanted.filter((name) => name !== "occurrences");
  if (!["coordenacao", "saude"].includes(viewer.coreRole) || !viewer.sessionId) wanted = wanted.filter((name) => name !== "medications");

  // roles and events are scoped together: a non-admin only learns about the
  // roles that survive in their events, so a change to either re-sends both
  const wantsSchedule = wanted.includes("roles") || wanted.includes("events");
  if (wantsSchedule && !scope.all) wanted = [...new Set([...wanted, "roles" as const, "events" as const])];
  const schedule = wantsSchedule
    ? (async () => {
        const [roles, all] = await Promise.all([listRoles(), listEvents()]);
        const roleById = new Map(roles.map((r) => [r._id, r]));
        const events = isParent(scope) ? all.filter((e) => e.visibleToParents) : all;
        const scopedEvents = events.map((e) => scopeEvent(scope, e, roleById));
        return { roles: scopeRoles(scope, roles, scopedEvents), events: scopedEvents };
      })()
    : null;

  await Promise.all(
    wanted.map(async (name) => {
      switch (name) {
        case "campers":
          out.campers = serializeCamperList(await listCampers(), scope);
          break;
        case "staff":
          out.staff = serializeStaffList(await listStaff(), scope);
          break;
        case "bedrooms": {
          const [list, occ] = await Promise.all([listBedrooms(), occupancy()]);
          out.bedrooms = list.filter((b) => canSeeBedroom(scope, b._id)).map((b) => serializeBedroom(b, occ.get(b._id)));
          break;
        }
        case "categories": {
          const isAdmin = role === "admin";
          out.categories = (await listCategories()).map((cat) => {
            const s = serializeCategory(cat);
            return isAdmin ? { ...s, options: s.options.filter((o) => !o.draft) } : { ...s, options: s.options.filter((o) => o.active && !o.draft) };
          });
          break;
        }
        case "transports":
          out.transports = (await listTransports()).map(serializeTransport);
          break;
        case "teams":
          out.teams = (await listTeams()).map(serializeTeam);
          break;
        case "scores":
          // suspense window: the ordinary team gets an empty ledger (the client shows the board with the totals hidden)
          out.scores = canSeeScores(scope, await getSettings()) ? (await listScores()).map(serializeScore) : [];
          break;
        case "roles":
          out.roles = (await schedule!).roles.map(serializeRole);
          break;
        case "events":
          out.events = (await schedule!).events.map(serializeEvent);
          break;
        case "preparation":
          out.preparation = serializePrepListFor(await listPrepSections(), scope);
          break;
        case "instructions":
          out.instructions = (await listInstructions()).filter((d) => canSeeDoc(scope, d)).map(serializeInstruction);
          break;
        case "occurrences": {
          const group = viewerOccurrenceGroup(scope);
          if (group) out.occurrences = (await occurrencesForGroup(await listOccurrences(), group)).map(serializeOccurrence);
          break;
        }
        case "medications": {
          const { findSession } = await import("./session");
          const session = viewer.sessionId ? await findSession(viewer.sessionId) : null;
          if (!session) break;
          const doses = await listMedicationDoses();
          const ids = await permittedMedicationIds(session, doses.map((d) => d.personId));
          out.medications = doses.filter((d) => ids.has(d.personId)).map(serializeMedicationDose);
          break;
        }
        case "gallery":
          // published album for the camp; photographers / organizers also see drafts.
          // parents may further FILTER it with POST /api/gallery/search-person.
          out.gallery = canManageGallery(scope) || (await getSettings()).galleryPublished ? (await listGalleryPhotos()).map(serializePhoto) : [];
          break;
        case "settings":
          // offenders list (out-of-scope emergency QR) + super-admin flag are manager-only
          out.settings = scope.all
            ? await serializeSettingsForManager(await getSettings(), isSuperAdmin(viewer.personId))
            : await serializeSettings(await getSettings());
          break;
      }
    }),
  );

  return out;
}
