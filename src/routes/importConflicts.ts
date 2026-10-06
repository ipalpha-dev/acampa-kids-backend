import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireManager } from "../middleware/roles";
import { findBedroomById } from "../models/bedrooms";
import { findCamperById, reassignCampers, updateCamper, type CamperData } from "../models/campers";
import { deleteImportConflictsById, findImportConflicts, listImportConflicts, type ImportConflict } from "../models/importConflicts";
import { findStaffById, updateStaff, type StaffData } from "../models/staff";
import { findTeamById } from "../models/teams";
import { findTransportById } from "../models/transports";
import { publish } from "../services/realtime";
import { ROOM_ROLES } from "../types";
import { bedroomFullMessage } from "./_validate";

/**
 * /api/import-conflicts — decision 78: import values that were NOT written
 * because someone had changed that camp field by hand since the last import.
 * The coordenação / organização decides each one on the campers / team page,
 * in the same style as the other import decisions:
 *
 *   GET  /?subject=camper|team        {items:[{id, personId, field, importValue, currentValue, importId, createdAt}]}
 *                                     (currentValue = the row's value NOW; entries that no longer differ are dropped)
 *   POST /resolve {ids, choice}       choice "import" (apply the import's value) | "keep" (keep the current one)
 *                                     → {applied, kept, failed:[{id, code, message}]}
 *
 * Ids + camp-ops values only; names are resolved on screen (people names).
 */
type Env = { Variables: AuthVariables };
const conflicts = new Hono<Env>();

conflicts.use("*", requireAuth, requireManager);

function fail(c: Context, code: string, message: string, status: 400 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

const MAX_IDS = 500;

type Row = Record<string, unknown> | null;

async function rowOf(conflict: ImportConflict): Promise<Row> {
  return (conflict.kind === "camper" ? await findCamperById(conflict.personId) : await findStaffById(conflict.personId)) as unknown as Row;
}

const valueOf = (row: NonNullable<Row>, field: string): string | null => {
  const v = row[field];
  return typeof v === "string" && v !== "" ? v : null;
};

conflicts.get("/", async (c) => {
  const subject = c.req.query("subject");
  if (subject !== "camper" && subject !== "team") return fail(c, "SUBJECT_INVALID", "Escolha acampantes ou equipe.");
  const items = [];
  const stale: string[] = [];
  for (const conflict of await listImportConflicts(subject)) {
    const row = await rowOf(conflict);
    const current = row ? valueOf(row, conflict.field) : null;
    // the row left the camp, or someone already set the import's value: nothing left to decide
    if (!row || (current ?? "") === (conflict.importValue ?? "")) {
      stale.push(conflict._id);
      continue;
    }
    items.push({ id: conflict._id, personId: conflict.personId, field: conflict.field, importValue: conflict.importValue, currentValue: current, importId: conflict.importId, createdAt: conflict.createdAt });
  }
  if (stale.length) await deleteImportConflictsById(stale);
  return c.json({ items });
});

/** Still a valid camp option (the room / vehicle / team may be gone since the import; a room may be full now). */
async function importValueProblem(conflict: ImportConflict, row: NonNullable<Row>): Promise<{ code: string; message: string } | null> {
  const value = conflict.importValue;
  if (!value) return null;
  switch (conflict.field) {
    case "bedroom": {
      const room = await findBedroomById(value);
      if (!room || (conflict.kind === "camper" && room.group === "staff")) return { code: "BEDROOM_NOT_FOUND", message: "Esse quarto não existe mais." };
      const full = await bedroomFullMessage(value, valueOf(row, "bedroom"));
      return full ? { code: "BEDROOM_FULL", message: full } : null;
    }
    case "transportation":
      return (await findTransportById(value)) ? null : { code: "TRANSPORT_NOT_FOUND", message: "Esse transporte não existe mais." };
    case "team":
      return (await findTeamById(value)) ? null : { code: "TEAM_NOT_FOUND", message: "Esse time não existe mais." };
    case "roomRole":
      return (ROOM_ROLES as readonly string[]).includes(value) ? null : { code: "ROOM_ROLE_INVALID", message: "Função no quarto inválida." };
    default:
      return null;
  }
}

conflicts.post("/resolve", async (c) => {
  const body = await c.req.json<{ ids?: unknown; choice?: unknown }>().catch(() => null);
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === "string" && x.length <= 64))] : [];
  if (ids.length === 0 || ids.length > MAX_IDS) return fail(c, "IDS_INVALID", "Escolha o que decidir.");
  const choice = body?.choice;
  if (choice !== "import" && choice !== "keep") return fail(c, "CHOICE_INVALID", "Escolha aplicar o valor da importação ou manter o atual.");
  const found = await findImportConflicts(ids);
  const done: string[] = [];
  const failed: { id: string; code: string; message: string }[] = [];
  let applied = 0;
  const touched = new Set<"campers" | "staff">();
  for (const conflict of found) {
    if (choice === "keep") {
      // the person's value stays — and stays remembered as a manual choice for the next import
      done.push(conflict._id);
      continue;
    }
    const row = await rowOf(conflict);
    if (!row) {
      done.push(conflict._id);
      continue;
    }
    const problem = await importValueProblem(conflict, row);
    if (problem) {
      failed.push({ id: conflict._id, ...problem });
      continue;
    }
    // "import" = the import's value, as if the import had written it (the field is no longer a manual choice)
    const patch: Record<string, unknown> = { [conflict.field]: conflict.importValue };
    if (conflict.kind === "camper") {
      if (conflict.field === "bedroom") Object.assign(patch, { bed: null, caretakerId: null });
      await updateCamper(conflict.personId, patch as Partial<CamperData>, "import");
      touched.add("campers");
    } else {
      // a room leader who moves room no longer looks after the kids of the old one
      if (conflict.field === "bedroom" || conflict.field === "roomRole") await reassignCampers(conflict.personId, null);
      await updateStaff(conflict.personId, patch as Partial<StaffData>, "import");
      touched.add("staff");
      touched.add("campers");
    }
    applied++;
    done.push(conflict._id);
  }
  await deleteImportConflictsById(done);
  if (touched.size) publish(...touched, "bedrooms");
  else if (done.length) publish("campers", "staff");
  return c.json({ applied, kept: choice === "keep" ? done.length : 0, failed });
});

export default conflicts;
