import { listCategories } from "../models/categories";
import { coreClient } from "./ipalpha";
import { IpalphaRejected, type HealthList } from "./ipalpha/coreClient";
import { writeHealth } from "./people";
import { PARTICIPANT_ROLE, RESPONSIBLE_ROLE, STAFF_CATEGORY_KEYS, type HealthInfo } from "../types";
import { normalizeBrazilPhone } from "../utils";

/**
 * Creating people in core for Acampa's imports / forms (CONTRACTS §12, §15):
 * persons `POST /registrations` (creates the person, or answers the existing
 * one — `created: false` — and the responsible→child link), then projects
 * memberships in the camp's edition with `onBehalf` / `involved`, all with
 * the COORDENAÇÃO role tokens of the acting session. Health goes to persons-api
 * (`medical`), mapped onto the church health lists.
 */
export interface CoordinationTokens {
  persons: string;
  projects: string;
}

export interface KidInput {
  name: string;
  birthDate: string;
  data?: Record<string, unknown>;
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
  if (extra.length) out.healthNotes = [health.healthNotes ?? "", `Informado na importação: ${[...new Set(extra)].join(", ")}.`].filter(Boolean).join(" ").trim();
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
 * A kid + their responsável: registration (responsible + child + link),
 * `participante` (on behalf of the responsável, who is involved) and
 * `responsavel` memberships in the edition, then the health block.
 */
export async function registerKid(tokens: CoordinationTokens, input: { kid: KidInput; guardian: GuardianInput; editionId: string; health?: Partial<HealthInfo> }): Promise<{ kidId: string; guardianId: string; created: boolean }> {
  const phone = normalizeBrazilPhone(input.guardian.phone);
  if (!phone) throw new IpalphaRejected(400, "missingResponsiblePhone", {});
  const guardianData: Record<string, unknown> = { ...(input.guardian.data ?? {}) };
  if (input.guardian.email) guardianData.email = [{ address: input.guardian.email }];
  const reg = await coreClient().register(tokens.persons, {
    role: PARTICIPANT_ROLE,
    responsible: { name: input.guardian.name, phone, ...(Object.keys(guardianData).length ? { data: guardianData } : {}) },
    children: [{ name: input.kid.name, birthDate: input.kid.birthDate, ...(input.kid.data ? { data: input.kid.data } : {}) }],
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
  if (input.health && Object.keys(input.health).length) await writeHealth(tokens.persons, child.personId, await healthToCore(tokens.persons, input.health));
  return { kidId: child.personId, guardianId: reg.responsible.personId, created: child.created };
}

/** An adult (team): registration + one membership per role in the edition, then the health block. */
export async function registerAdult(tokens: CoordinationTokens, input: { name: string; phone: string; email?: string | null; birthDate?: string | null; roles: string[]; editionId: string; data?: Record<string, unknown>; health?: Partial<HealthInfo> }): Promise<{ personId: string; created: boolean }> {
  const phone = normalizeBrazilPhone(input.phone);
  if (!phone) throw new IpalphaRejected(400, "missingPhone", {});
  const data: Record<string, unknown> = { ...(input.data ?? {}) };
  if (input.email) data.email = [{ address: input.email }];
  const reg = await coreClient().register(tokens.persons, {
    role: input.roles[0],
    people: [{ name: input.name, phone, ...(input.birthDate ? { birthDate: input.birthDate } : {}), ...(Object.keys(data).length ? { data } : {}) }],
  });
  const person = reg.people[0];
  if (!person) throw new IpalphaRejected(502, "registrationIncomplete", {});
  for (const role of input.roles) await addMembership(tokens.projects, { personId: person.personId, role, editionId: input.editionId });
  if (input.health && Object.keys(input.health).length) await writeHealth(tokens.persons, person.personId, await healthToCore(tokens.persons, input.health));
  return { personId: person.personId, created: person.created };
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
