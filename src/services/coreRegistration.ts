import { listCategories } from "../models/categories";
import { coreClient } from "./ipalpha";
import { IpalphaRejected, toCoreSex, type HealthList, type RegistrationPerson } from "./ipalpha/coreClient";
import { hasHealthInfo } from "./people";
import { EMPTY_HEALTH, PARTICIPANT_ROLE, RESPONSIBLE_ROLE, STAFF_CATEGORY_KEYS, type CamperSex, type HealthInfo } from "../types";
import { normalizeBrazilPhone } from "../utils";

/**
 * Creating people in core for Acampa's imports / forms (CONTRACTS §12, §15):
 * persons `POST /registrations` (creates the person, or answers the existing
 * one — `created: false` — and the responsible→child link), then projects
 * memberships in the camp's edition with `onBehalf` / `involved`, all with
 * the COORDENAÇÃO role tokens of the acting session.
 *
 * The registration body carries everything core's `RegistrationPersonDto`
 * takes (persons-api src/registrations/registration.dto.ts): the profile
 * fields `sex` (only when the spreadsheet / form said it — never guessed) and
 * `homeChurch`, and `data` blocks per kind — `document`, `school`,
 * `emergencyContact` and `medical` (health mapped onto the church health
 * lists). Core writes only the kinds the target role collects.
 */
export interface CoordinationTokens {
  persons: string;
  projects: string;
}

export interface KidInput {
  name: string;
  birthDate: string;
  /** explicit only (spreadsheet / form) — never guessed */
  sex?: CamperSex | null;
  homeChurch?: string;
  data?: Record<string, unknown>;
}

/** `sex` / `homeChurch` of a registration entry, only when there is a value. */
function profileOf(input: { sex?: CamperSex | null; homeChurch?: string | null }): Pick<RegistrationPerson, "sex" | "homeChurch"> {
  const sex = toCoreSex(input.sex);
  const homeChurch = (input.homeChurch ?? "").trim().slice(0, 120);
  return { ...(sex ? { sex } : {}), ...(homeChurch ? { homeChurch } : {}) };
}

/**
 * The persons `medical` block of a registration: the health mapped onto the
 * church lists over an empty block, or undefined when there is nothing to say.
 */
export async function medicalBlock(token: string, health: Partial<HealthInfo> | undefined): Promise<HealthInfo | undefined> {
  if (!health || Object.keys(health).length === 0) return undefined;
  const block: HealthInfo = { ...EMPTY_HEALTH, ...(await healthToCore(token, health)) };
  const hasExtras = block.weightKg != null || !!block.insurance.trim() || !!block.insuranceCard.trim();
  return hasHealthInfo(block) || hasExtras ? block : undefined;
}

/** `data` with the `medical` block added when there is one. */
async function withMedical(token: string, data: Record<string, unknown> | undefined, health: Partial<HealthInfo> | undefined): Promise<Record<string, unknown> | undefined> {
  const medical = await medicalBlock(token, health);
  const out: Record<string, unknown> = { ...(data ?? {}), ...(medical ? { medical } : {}) };
  return Object.keys(out).length ? out : undefined;
}

export interface GuardianInput {
  name: string;
  phone: string;
  email?: string;
  data?: Record<string, unknown>;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();

function labelOf(label: HealthList["options"][number]["label"]): string {
  return typeof label === "string" ? label : (label["pt-BR"] ?? Object.values(label)[0] ?? "");
}

/**
 * Acampa's import categories (local option ids) → the church health lists'
 * option ids by label. What has no matching option is not lost: it goes into
 * `healthNotes` as text (the coordenação asks Mordomia to add the option).
 */
export async function healthToCore(token: string, health: Partial<HealthInfo>, lists?: HealthList[]): Promise<Partial<HealthInfo>> {
  const out: Partial<HealthInfo> = { ...health };
  const fields = (["allergies", "drugAllergies", "healthIssues"] as const).filter((f) => Array.isArray(health[f]) && health[f]!.length);
  if (fields.length === 0) return out;
  const coreLists = lists ?? (await coreClient().healthLists(token));
  const categories = await listCategories();
  const extra: string[] = [];
  for (const field of fields) {
    const local = categories.find((c) => c.key === STAFF_CATEGORY_KEYS[field]);
    const list = coreLists.find((l) => l.key === STAFF_CATEGORY_KEYS[field]);
    const byLabel = new Map((list?.options ?? []).filter((o) => o.active).map((o) => [norm(labelOf(o.label)), o.id]));
    const coreIds = new Set((list?.options ?? []).filter((o) => o.active).map((o) => o.id));
    const ids: string[] = [];
    for (const id of health[field]!) {
      if (coreIds.has(id)) {
        ids.push(id);
        continue;
      }
      const label = local?.options.find((o) => o.id === id)?.label ?? "";
      const match = label ? byLabel.get(norm(label)) : undefined;
      if (match) ids.push(match);
      else if (label) extra.push(label);
    }
    out[field] = [...new Set(ids)];
  }
  if (extra.length) out.healthNotes = [health.healthNotes ?? "", `Também informado: ${[...new Set(extra)].join(", ")}.`].filter(Boolean).join(" ").trim();
  return out;
}

async function addMembership(token: string, input: Parameters<ReturnType<typeof coreClient>["addMembership"]>[1]): Promise<void> {
  try {
    await coreClient().addMembership(token, input);
  } catch (err) {
    // idempotent in core; a 409 means the row is already there
    if (err instanceof IpalphaRejected && err.status === 409) return;
    throw err;
  }
}

/**
 * A kid + their responsável: registration (responsible + child + link, the
 * kid's profile fields and data blocks incl. `medical`), then `participante`
 * (on behalf of the responsável, who is involved) and `responsavel`
 * memberships in the edition.
 */
export async function registerKid(tokens: CoordinationTokens, input: { kid: KidInput; guardian: GuardianInput; editionId: string; health?: Partial<HealthInfo> }): Promise<{ kidId: string; guardianId: string; created: boolean }> {
  const phone = normalizeBrazilPhone(input.guardian.phone);
  if (!phone) throw new IpalphaRejected(400, "missingResponsiblePhone", {});
  const guardianData: Record<string, unknown> = { ...(input.guardian.data ?? {}) };
  if (input.guardian.email) guardianData.email = [{ address: input.guardian.email }];
  const kidData = await withMedical(tokens.persons, input.kid.data, input.health);
  const reg = await coreClient().register(tokens.persons, {
    role: PARTICIPANT_ROLE,
    responsible: { name: input.guardian.name, phone, ...(Object.keys(guardianData).length ? { data: guardianData } : {}) },
    children: [{ name: input.kid.name, birthDate: input.kid.birthDate, ...profileOf(input.kid), ...(kidData ? { data: kidData } : {}) }],
  });
  const child = reg.children[0];
  if (!reg.responsible || !child) throw new IpalphaRejected(502, "registrationIncomplete", {});
  await addMembership(tokens.projects, {
    personId: child.personId,
    role: PARTICIPANT_ROLE,
    editionId: input.editionId,
    ...(child.linkId ? { onBehalf: { by: reg.responsible.personId, via: child.linkId } } : {}),
    involved: [{ personId: reg.responsible.personId, purpose: "responsible", kinds: [] }],
  });
  await addMembership(tokens.projects, { personId: reg.responsible.personId, role: RESPONSIBLE_ROLE, editionId: input.editionId });
  return { kidId: child.personId, guardianId: reg.responsible.personId, created: child.created };
}

/** An adult (team): registration (profile fields + data blocks incl. `medical`), then one membership per role in the edition. */
export async function registerAdult(tokens: CoordinationTokens, input: { name: string; phone: string; email?: string | null; birthDate?: string | null; sex?: CamperSex | null; homeChurch?: string | null; roles: string[]; editionId: string; data?: Record<string, unknown>; health?: Partial<HealthInfo> }): Promise<{ personId: string; created: boolean }> {
  const phone = normalizeBrazilPhone(input.phone);
  if (!phone) throw new IpalphaRejected(400, "missingPhone", {});
  const base: Record<string, unknown> = { ...(input.data ?? {}) };
  if (input.email) base.email = [{ address: input.email }];
  const data = await withMedical(tokens.persons, base, input.health);
  const reg = await coreClient().register(tokens.persons, {
    role: input.roles[0],
    people: [{ name: input.name, phone, ...(input.birthDate ? { birthDate: input.birthDate } : {}), ...profileOf(input), ...(data ? { data } : {}) }],
  });
  const person = reg.people[0];
  if (!person) throw new IpalphaRejected(502, "registrationIncomplete", {});
  for (const role of input.roles) await addMembership(tokens.projects, { personId: person.personId, role, editionId: input.editionId });
  return { personId: person.personId, created: person.created };
}

/**
 * One more responsável for a kid already in core (decision 38): the adult is
 * registered (or found by phone), linked to the kid (persons `POST /links`),
 * named as involved on the kid's `participante` membership and given the
 * `responsavel` role — never a second copy of the kid.
 */
export async function addResponsible(tokens: CoordinationTokens, input: { kidId: string; guardian: GuardianInput; editionId: string }): Promise<{ guardianId: string; linked: boolean }> {
  const { personId: guardianId } = await registerAdult(tokens, { name: input.guardian.name, phone: input.guardian.phone, email: input.guardian.email ?? null, roles: [RESPONSIBLE_ROLE], editionId: input.editionId, data: input.guardian.data });
  let linked = true;
  let linkId: string | null = null;
  try {
    linkId = (await coreClient().link(tokens.persons, { subjectId: input.kidId, agentId: guardianId })).linkId;
  } catch (err) {
    // an existing link answers 409; anything else is a refusal of this link only
    if (!(err instanceof IpalphaRejected)) throw err;
    linked = err.status === 409;
  }
  await addMembership(tokens.projects, {
    personId: input.kidId,
    role: PARTICIPANT_ROLE,
    editionId: input.editionId,
    ...(linkId ? { onBehalf: { by: guardianId, via: linkId } } : {}),
    involved: [{ personId: guardianId, purpose: "responsible", kinds: [] }],
  });
  return { guardianId, linked };
}

/** A role for an existing person in the edition (helper roles from a staff spreadsheet). */
export async function grantRole(tokens: CoordinationTokens, personId: string, role: string, editionId: string): Promise<boolean> {
  try {
    await addMembership(tokens.projects, { personId, role, editionId });
    return true;
  } catch (err) {
    if (err instanceof IpalphaRejected) return false;
    throw err;
  }
}

/** "CPF / RG" free text → persons `document` entries (only well-formed ones). */
export function documentsOf(input: { cpf?: string; rg?: string; text?: string }): { type: string; number: string }[] {
  const out: { type: string; number: string }[] = [];
  const cpf = (input.cpf ?? "").replace(/\D/g, "") || ((input.text ?? "").match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/)?.[0] ?? "").replace(/\D/g, "");
  if (cpf.length === 11) out.push({ type: "cpf", number: cpf });
  const rg = (input.rg ?? "").trim();
  if (rg) out.push({ type: "rg", number: rg.slice(0, 40) });
  return out;
}

/** "Maria (mãe) 11 98765-4321" → persons `emergencyContact` (§12), or null when no phone can be read. */
export function emergencyContactOf(text: string): { name: string; phone: string; relation?: string } | null {
  const digits = text.match(/(\+?\d[\d\s().-]{8,}\d)/)?.[1] ?? "";
  const phone = digits ? normalizeBrazilPhone(digits) : null;
  if (!phone) return null;
  const rest = text.replace(digits, "").replace(/[-–:,;|/]+/g, " ").replace(/\s+/g, " ").trim();
  const relation = rest.match(/\(([^)]+)\)/)?.[1]?.trim();
  const name = rest.replace(/\([^)]*\)/g, "").trim();
  return { name: name || "Contato de emergência", phone, ...(relation ? { relation } : {}) };
}

/**
 * The optional person fields of a manual registration body (`POST
 * /api/campers/register`, `POST /api/staff/register`) that core's registration
 * takes: `sex` ("F" | "M", only when the person said it), `homeChurch`, and
 * the `school` / `emergencyContact` blocks. Absent / empty = not sent.
 */
export function registrationExtras(body: Record<string, unknown>): { ok: true; sex: CamperSex | null; homeChurch: string; data: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const sex = body.sex === undefined || body.sex === null || body.sex === "" ? null : body.sex === "F" || body.sex === "M" ? body.sex : undefined;
  if (sex === undefined) return { ok: false, code: "SEX_INVALID", message: "Sexo inválido." };
  if (body.homeChurch !== undefined && body.homeChurch !== null && typeof body.homeChurch !== "string") return { ok: false, code: "HOME_CHURCH_INVALID", message: "Igreja inválida." };
  const homeChurch = typeof body.homeChurch === "string" ? body.homeChurch.trim() : "";
  if (homeChurch.length > 120) return { ok: false, code: "HOME_CHURCH_INVALID", message: "Informe a igreja com até 120 caracteres." };
  const data: Record<string, unknown> = {};
  const school = body.school && typeof body.school === "object" ? (body.school as Record<string, unknown>) : null;
  if (school) {
    const name = typeof school.name === "string" ? school.name.trim().slice(0, 120) : "";
    const grade = typeof school.grade === "string" ? school.grade.trim().slice(0, 60) : "";
    if (name || grade) data.school = { name, grade };
  }
  if (typeof body.emergencyContact === "string" && body.emergencyContact.trim()) {
    const contact = emergencyContactOf(body.emergencyContact);
    if (!contact) return { ok: false, code: "EMERGENCY_CONTACT_INVALID", message: "Informe um celular válido no contato de emergência." };
    data.emergencyContact = contact;
  } else if (body.emergencyContact && typeof body.emergencyContact === "object") {
    const e = body.emergencyContact as Record<string, unknown>;
    const phone = typeof e.phone === "string" ? normalizeBrazilPhone(e.phone) : null;
    if (!phone) return { ok: false, code: "EMERGENCY_CONTACT_INVALID", message: "Informe um celular válido no contato de emergência." };
    const relation = typeof e.relation === "string" ? e.relation.trim().slice(0, 60) : "";
    data.emergencyContact = { name: typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 120) : "Contato de emergência", phone, ...(relation ? { relation } : {}) };
  }
  return { ok: true, sex, homeChurch, data };
}

/** `sex` / `homeChurch` of a registration entry (exported for the manual registration routes). */
export function registrationProfile(input: { sex?: CamperSex | null; homeChurch?: string | null }): Pick<RegistrationPerson, "sex" | "homeChurch"> {
  return profileOf(input);
}

/** `data` blocks + the `medical` block (exported for the manual registration routes). */
export function registrationData(token: string, data: Record<string, unknown> | undefined, health: Partial<HealthInfo> | undefined): Promise<Record<string, unknown> | undefined> {
  return withMedical(token, data, health);
}
