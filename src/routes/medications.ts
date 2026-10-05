import { Hono, type Context } from "hono";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { findCamperById, listCampers } from "../models/campers";
import { deleteMedicationDose, findMedicationDoseById, insertMedicationDose, listMedicationDoses, medKeyOf } from "../models/medications";
import { publish } from "../services/realtime";
import { resolveScope } from "../services/scope";
import { todayInSaoPaulo } from "../utils";
import { MEDICATION_SOS_SLOT, PARTICIPANT_ROLE, type MedicationDose } from "../types";
import { actingToken } from "../services/acting";
import { coreClient } from "../services/ipalpha";
import { PERSONS_RESOURCE } from "../services/ipalpha/coreClient";
import { MEDICAL_KIND, readHealth, toHealth } from "../services/people";

type Env = { Variables: AuthVariables };

/**
 * Medicações — the medical team's daily checklist of the CONTINUOUS
 * medication the kids take. The prescription lives in persons-api (the
 * kid's `medical` block, read with the acting role token — logged by core);
 * here the team only ticks what was actually given.
 *
 *   GET    /api/medications                every tick (coordenação / organização / saúde)
 *   GET    /api/medications/prescriptions  the kids of this camp with medicines (name + medications), live from core
 *   POST   /api/medications                tick one dose { personId, medName, day?, slot, note? }
 *   DELETE /api/medications/:id      untick (a mistake)
 *
 * A scheduled slot ("HH:MM") is one tick per kid, medicine and day — posting
 * it twice returns the same record. "quando necessário" doses (slot "sos")
 * may repeat in the same day.
 */
const medications = new Hono<Env>();

const NOTE_MAX = 300;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeMedicationDose(d: MedicationDose) {
  return {
    id: d._id,
    personId: d.personId,
    medKey: d.medKey,
    medName: d.medName,
    dose: d.dose,
    day: d.day,
    slot: d.slot,
    givenAt: d.givenAt,
    byPersonId: d.byPersonId,
    note: d.note,
  };
}

/** Admin / organizer (`all`) or the MEDICAL team. Nobody else sees the checklist. */
async function medicationAccess(c: Context<Env, string>): Promise<boolean> {
  const role = c.get("activeRole");
  if (role === "admin") return true;
  if (role !== "staff") return false;
  const scope = await resolveScope(c.get("user"));
  return scope.all || scope.medical;
}

medications.use("*", requireAuth);

medications.get("/", async (c) => {
  if (!(await medicationAccess(c))) return fail(c, "FORBIDDEN", "Só a equipe médica e a organização veem as medicações.", 403);
  return c.json({ medications: (await listMedicationDoses()).map(serializeMedicationDose) });
});

/**
 * GET /api/medications/prescriptions?cursor — one page (≤ 200) of the camp's
 * kids who take medicines: `{items: [{personId, name, medications}], nextCursor}`.
 * Read from persons-api with the acting role token (role rules decide).
 */
medications.get("/prescriptions", async (c) => {
  if (!(await medicationAccess(c))) return fail(c, "FORBIDDEN", "Só a equipe médica e a organização veem as medicações.", 403);
  const kids = new Set((await listCampers()).map((k) => k._id));
  const page = await coreClient().listPeople(actingToken(c, PERSONS_RESOURCE), { role: PARTICIPANT_ROLE, kinds: [MEDICAL_KIND], cursor: c.req.query("cursor") || undefined, limit: 200 });
  const items = page.items
    .filter((p) => kids.has(p.personId))
    .map((p) => ({ personId: p.personId, name: p.name, medications: toHealth(p.data.health).medications }))
    .filter((p) => p.medications.length > 0);
  return c.json({ items, nextCursor: page.nextCursor });
});

medications.post("/", async (c) => {
  if (!(await medicationAccess(c))) return fail(c, "FORBIDDEN", "Só a equipe médica e a organização marcam medicações.", 403);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const camper = typeof body.personId === "string" ? await findCamperById(body.personId) : null;
  if (!camper) return fail(c, "CAMPER_NOT_FOUND", "Criança não encontrada.", 404);

  const medName = typeof body.medName === "string" ? body.medName.trim().slice(0, 120) : "";
  if (!medName) return fail(c, "MED_REQUIRED", "Informe qual medicamento foi dado.");
  const medKey = medKeyOf(medName);
  // the medicine must be on the kid's prescription (persons-api, read now with the acting token)
  const health = await readHealth(actingToken(c, PERSONS_RESOURCE), camper._id);
  const prescribed = health?.medications.find((m) => medKeyOf(m.name) === medKey);
  if (!prescribed) return fail(c, "MED_NOT_PRESCRIBED", `${medName} não está na medicação desta criança.`, 404);

  const slot = typeof body.slot === "string" ? body.slot.trim() : "";
  const scheduled = TIME_RE.test(slot);
  if (!scheduled && slot !== MEDICATION_SOS_SLOT) return fail(c, "SLOT_INVALID", "Horário inválido (use HH:MM ou \"sos\").");
  if (scheduled && !prescribed.times.includes(slot)) return fail(c, "SLOT_UNKNOWN", `${medName} não tem o horário ${slot}.`);
  if (!scheduled && !prescribed.asNeeded) return fail(c, "SLOT_UNKNOWN", `${medName} tem horário fixo.`);

  const day = typeof body.day === "string" && DAY_RE.test(body.day) ? body.day : todayInSaoPaulo();
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";
  const user = c.get("user");
  const created = await insertMedicationDose(
    { personId: camper._id, medKey, medName: prescribed.name, dose: prescribed.dose, day, slot, byPersonId: user.id, note },
    scheduled,
  );
  publish("medications");
  return c.json({ medication: serializeMedicationDose(created) }, 201);
});

medications.delete("/:id", async (c) => {
  if (!(await medicationAccess(c))) return fail(c, "FORBIDDEN", "Só a equipe médica e a organização marcam medicações.", 403);
  const dose = await findMedicationDoseById(c.req.param("id"));
  if (!dose) return fail(c, "DOSE_NOT_FOUND", "Marcação não encontrada.", 404);
  await deleteMedicationDose(dose._id);
  publish("medications");
  return c.json({ success: true });
});

export default medications;
