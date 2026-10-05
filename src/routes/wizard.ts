import { Hono } from "hono";
import sampleJson from "../sample/camp.json";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { insertBedroom, sexOfGroup } from "../models/bedrooms";
import { EMPTY_CAMPER, findCamperById, insertCamper, listCampers } from "../models/campers";
import { EMPTY_STAFF, insertStaff, listStaff } from "../models/staff";
import { insertTeam } from "../models/teams";
import { insertTransport } from "../models/transports";
import { publish } from "../services/realtime";
import { coordinationContext } from "../services/acting";
import { documentsOf, emergencyContactOf, registerAdult, registerKid } from "../services/coreRegistration";
import { TEAM_ROLE, type BedroomGroup, type CamperSex } from "../types";

const wizard = new Hono<{ Variables: AuthVariables }>();

/** The fictional camp shipped with the app (see data/make_sample.py at the repo root). */
const SAMPLE = sampleJson as {
  teams: { name: string; color: string }[];
  rooms: { name: string; group: BedroomGroup; bunkBeds: number; singleBeds: number }[];
  transports: { kind: "bus" | "car"; number?: string; color?: string; name?: string }[];
  staff: { name: string; phone: string; team: string | null; room: string | null; roomGroup: BedroomGroup | null; transportation: string | null; roomRole: "caretaker" | "helper"; active: boolean; healthNotes: string }[];
  campers: {
    name: string; birthDate: string | null; sex: CamperSex; cpf: string; rg: string; school: string; schoolGrade: string; church: string; invitedBy: string;
    team: string | null; room: string | null; roomGroup: BedroomGroup | null; transportation: string | null; bed: string | null; weightKg: number | null;
    allergies: string[]; healthIssues: string[]; foodRestrictions: string; healthNotes: string; generalNotes: string; bedroomPreference: string;
    insurance: string; insuranceCard: string; emergencyContact: string; guardianName: string; guardianPhone: string; guardianCpf: string; guardianEmail: string;
  }[];
};

wizard.use("*", requireAuth);

/**
 * POST /api/wizard/sample — coordenação. Fills an EMPTY camp with the
 * fictional sample (154 kids, 72 team members, teams, rooms and buses) so the
 * whole system can be tested end-to-end. The PEOPLE are registered in IPAlpha
 * (persons registration + memberships of the camp's edition, with the
 * coordenação tokens — synthetic data, previews only); Acampa keeps the camp
 * ops. Refuses when the camp already has people — clean up first.
 */
wizard.post("/sample", requireAdmin, async (c) => {
  const [campers, staff] = await Promise.all([listCampers(), listStaff({ includeDraft: true })]);
  if (campers.length > 0 || staff.length > 0) {
    return c.json({ error: { code: "SAMPLE_NOT_EMPTY", message: "O acampamento já tem pessoas cadastradas. Limpe (Configurações → Limpeza) antes de carregar os dados de exemplo." } }, 409);
  }
  const ctx = await coordinationContext(c.get("session"));
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);

  // teams → rooms → vehicles, so people can reference them right away
  const teamId = new Map<string, string>();
  for (const [i, t] of SAMPLE.teams.entries()) {
    const created = await insertTeam({ name: t.name, color: t.color, order: i });
    teamId.set(t.name, created._id);
  }

  const roomId = new Map<string, string>();
  for (const r of SAMPLE.rooms) {
    const created = await insertBedroom({ name: r.name, group: r.group, bunkBeds: r.bunkBeds, singleBeds: r.singleBeds, notes: "" });
    roomId.set(`${r.group}:${r.name}`, created._id);
  }

  const transportId = new Map<string, string>();
  for (const [i, t] of SAMPLE.transports.entries()) {
    const created = await insertTransport(
      t.kind === "bus" ? { kind: "bus", number: t.number, color: t.color, order: i } : { kind: "car", name: t.name, order: i },
    );
    transportId.set(t.kind === "bus" ? `bus:${t.number}` : "car", created._id);
  }

  let staffCreated = 0;
  for (const s of SAMPLE.staff) {
    const { personId } = await registerAdult(ctx.tokens, { name: s.name, phone: s.phone, roles: [TEAM_ROLE], editionId: ctx.editionId, health: s.healthNotes ? { healthNotes: s.healthNotes } : undefined });
    await insertStaff(personId, {
      ...EMPTY_STAFF,
      sex: sexOfGroup(s.roomGroup),
      active: s.active,
      team: s.team ? teamId.get(s.team) ?? null : null,
      bedroom: s.room && s.roomGroup ? roomId.get(`${s.roomGroup}:${s.room}`) ?? null : null,
      roomRole: s.roomRole,
      transportation: s.transportation ? transportId.get(s.transportation) ?? null : null,
    });
    staffCreated++;
  }

  let campersCreated = 0;
  for (const k of SAMPLE.campers) {
    if (!k.birthDate) continue;
    const kidData: Record<string, unknown> = {};
    const docs = documentsOf({ cpf: k.cpf, rg: k.rg });
    if (docs.length) kidData.document = docs;
    if (k.school || k.schoolGrade) kidData.school = { name: k.school, grade: k.schoolGrade };
    const emergency = emergencyContactOf(k.emergencyContact);
    if (emergency) kidData.emergencyContact = emergency;
    const guardianDocs = documentsOf({ cpf: k.guardianCpf });
    const { kidId } = await registerKid(ctx.tokens, {
      kid: { name: k.name, birthDate: k.birthDate, data: kidData },
      guardian: { name: k.guardianName, phone: k.guardianPhone, email: k.guardianEmail || undefined, data: guardianDocs.length ? { document: guardianDocs } : undefined },
      editionId: ctx.editionId,
      health: { allergies: k.allergies, healthIssues: k.healthIssues, foodRestrictions: k.foodRestrictions, healthNotes: k.healthNotes, weightKg: k.weightKg, insurance: k.insurance, insuranceCard: k.insuranceCard },
    });
    if (await findCamperById(kidId)) continue;
    const bedroom = k.room && k.roomGroup ? roomId.get(`${k.roomGroup}:${k.room}`) ?? null : null;
    await insertCamper(kidId, {
      ...EMPTY_CAMPER,
      sex: sexOfGroup(k.roomGroup) ?? (k.sex as CamperSex),
      invitedBy: k.invitedBy,
      qrToken: crypto.randomUUID(),
      team: k.team ? teamId.get(k.team) ?? null : null,
      transportation: k.transportation ? transportId.get(k.transportation) ?? null : null,
      bed: k.bed || null,
      bedroom,
      generalNotes: k.generalNotes,
      bedroomPreference: k.bedroomPreference,
    });
    campersCreated++;
  }

  console.log(`🧪 sample camp loaded: ${campersCreated} campers, ${staffCreated} staff`);
  publish("campers", "staff", "bedrooms", "transports", "teams");
  return c.json({
    campers: campersCreated,
    staff: staffCreated,
    bedrooms: SAMPLE.rooms.length,
    transports: SAMPLE.transports.length,
    teams: SAMPLE.teams.length,
  });
});

export default wizard;
