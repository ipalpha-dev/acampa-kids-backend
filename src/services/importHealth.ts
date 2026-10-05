import { listCategories } from "../models/categories";
import { openImportJobToken, pauseImportForSignIn } from "../models/camperImports";
import { coreClient } from "./ipalpha";
import { IpalphaRejected, type HealthList } from "./ipalpha/coreClient";
import { healthToCore } from "./coreRegistration";
import { MEDICAL_KIND, mergeHealth, toHealth, writeHealth } from "./people";
import { EMPTY_HEALTH, STAFF_CATEGORY_KEYS, type HealthInfo } from "../types";

/**
 * AI health of imports written straight to persons-api (decision 50). The
 * background worker holds no session: it uses the importing coordenação's
 * persons-api role token, sealed on the import job (models/camperImports.ts)
 * and deleted when the job ends. No health ever rests in Acampa's Mongo — the
 * worker reads the person's block, merges the AI result over it (lists
 * unioned, texts appended, nothing erased) and writes it back, all in memory.
 *
 * A refused / expired token pauses the job (`needsSignIn`); the importer signs
 * in again and resumes it (`POST /api/camper-imports/:id/resume`).
 */

/** The import has no usable token: pause it and leave its rows for the resume. */
export class ImportNeedsSignIn extends Error {
  constructor(readonly importId: string) {
    super(`import ${importId} needs a new sign-in`);
  }
}

/** The importer's persons token of the job, or `ImportNeedsSignIn` (none / expired). */
export async function importToken(importId: string): Promise<string> {
  const job = await openImportJobToken(importId);
  if (!job) throw new ImportNeedsSignIn(importId);
  return job.token;
}

/** Pauses the job for a new sign-in; true when this call paused it. */
export function pauseForSignIn(importId: string): Promise<boolean> {
  return pauseImportForSignIn(importId);
}

/**
 * The person's current health block, or `null` when the token's role may not
 * read it (403) — a blind write would erase what is there, so the caller must
 * not write then. No block yet (404) = an empty block.
 */
export async function currentHealth(token: string, personId: string): Promise<HealthInfo | null> {
  try {
    return toHealth(await coreClient().readData(token, personId, MEDICAL_KIND));
  } catch (err) {
    if (err instanceof IpalphaRejected && err.status === 404) return { ...EMPTY_HEALTH };
    if (err instanceof IpalphaRejected && err.status === 403) return null;
    throw err;
  }
}

export type HealthWrite = "written" | "unchanged" | "refused";

/**
 * Merges an AI health patch (Acampa import option ids or church ids) over the
 * person's current block and writes it with the importer's token. `refused` =
 * core's role rules refused the read or the write for this person (logged by
 * the caller with ids only). A 401 throws `IpalphaTokenRevoked`.
 */
export async function writeImportHealth(token: string, personId: string, patch: Partial<HealthInfo>, lists?: HealthList[]): Promise<HealthWrite> {
  const current = await currentHealth(token, personId);
  if (!current) return "refused";
  const merged = mergeHealth(current, await healthToCore(token, patch, lists));
  // only what really changes is written (a repeated AI pass is a no-op)
  for (const key of Object.keys(merged) as (keyof HealthInfo)[]) if (JSON.stringify(merged[key]) === JSON.stringify(current[key])) delete merged[key];
  if (Object.keys(merged).length === 0) return "unchanged";
  try {
    await writeHealth(token, personId, merged, current);
    return "written";
  } catch (err) {
    if (err instanceof IpalphaRejected && err.status !== 401) return "refused";
    throw err;
  }
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();

function labelOf(label: HealthList["options"][number]["label"]): string {
  return typeof label === "string" ? label : (label["pt-BR"] ?? Object.values(label)[0] ?? "");
}

/**
 * Church option ids of a core block → Acampa's import option ids (by label),
 * the structured base the cleanup model builds on. Ids without a local option
 * are left out here — the merge keeps them in core anyway.
 */
export async function toImportOptionIds(health: HealthInfo, lists: HealthList[]): Promise<HealthInfo> {
  const categories = await listCategories();
  const out: HealthInfo = { ...health };
  for (const field of ["allergies", "drugAllergies", "healthIssues"] as const) {
    const local = categories.find((c) => c.key === STAFF_CATEGORY_KEYS[field]);
    const list = lists.find((l) => l.key === STAFF_CATEGORY_KEYS[field]);
    const localByLabel = new Map((local?.options ?? []).map((o) => [norm(o.label), o.id]));
    const localIds = new Set((local?.options ?? []).map((o) => o.id));
    out[field] = [
      ...new Set(
        health[field]
          .map((id) => {
            if (localIds.has(id)) return id;
            const option = list?.options.find((o) => o.id === id);
            return option ? localByLabel.get(norm(labelOf(option.label))) : undefined;
          })
          .filter((id): id is string => !!id),
      ),
    ];
  }
  return out;
}
