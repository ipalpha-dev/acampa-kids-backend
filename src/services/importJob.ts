import type { Context } from "hono";
import type { AuthVariables } from "../middleware/auth";
import { endImportJobIfIdle, findCamperImport, listImportsNeedingSignIn, resumeImportWithToken, storeImportJobToken, type CamperImportRecord } from "../models/camperImports";
import { coordinationJobToken } from "./acting";
import type { Session } from "../types";

/**
 * The import job's background AI health pass (decision 50): at Apply the
 * importing coordenação's persons token is sealed on the job; it is deleted
 * when the job ends. A refused / expired token pauses the job (`needsSignIn`)
 * and only the importer resumes it, after signing in again, with the fresh
 * token of the new session.
 */

/** Seals the importer's token on the job (Apply, right after the claim). False when the session has none. */
export async function startImportJob(importId: string, session: Session): Promise<boolean> {
  const job = coordinationJobToken(session);
  if (!job) return false;
  await storeImportJobToken(importId, job);
  return true;
}

/** The status an Apply ends with: `completed`, unless the worker already paused the job meanwhile. */
export async function appliedStatus(importId: string): Promise<"completed" | "needsSignIn"> {
  return (await findCamperImport(importId))?.status === "needsSignIn" ? "needsSignIn" : "completed";
}

/** The Apply failed: the job ends now unless rows it inserted still wait for the worker. */
export async function endFailedImportJob(importId: string): Promise<void> {
  await endImportJobIfIdle(importId);
}

/** The fields every import answer adds about the background pass. */
export function jobFields(record: CamperImportRecord): { needsSignIn: boolean; pausedAt: Date | null } {
  return { needsSignIn: record.status === "needsSignIn", pausedAt: record.pausedAt };
}

type Fail = { status: 403 | 404 | 409; error: { code: string; message: string } };

/**
 * `POST …/:id/resume` — the importer, signed in again as coordenação, resumes
 * a paused job: the fresh token is sealed on it and the worker picks its rows
 * up again. Only the person who started the import (decision 50).
 */
export async function resumeImportJob(c: Context<{ Variables: AuthVariables }>, subject: "camper" | "staff"): Promise<{ ok: true; record: CamperImportRecord } | ({ ok: false } & Fail)> {
  const record = await findCamperImport(c.req.param("id") ?? "");
  if (!record || record.subject !== subject) return { ok: false, status: 404, error: { code: "IMPORT_NOT_FOUND", message: "Importação não encontrada." } };
  if (record.status !== "needsSignIn") return { ok: false, status: 409, error: { code: "IMPORT_NOT_PAUSED", message: "Esta importação não está esperando um novo login." } };
  const session = c.get("session");
  if (session.personId !== record.createdByPersonId) return { ok: false, status: 403, error: { code: "IMPORT_NOT_YOURS", message: "Só quem começou esta importação pode retomá-la." } };
  const job = coordinationJobToken(session);
  if (!job) return { ok: false, status: 403, error: { code: "COORDINATION_REQUIRED", message: "Entre como coordenação para retomar a importação." } };
  const resumed = await resumeImportWithToken(record._id, job);
  if (!resumed) return { ok: false, status: 409, error: { code: "IMPORT_NOT_PAUSED", message: "Esta importação não está esperando um novo login." } };
  return { ok: true, record: resumed };
}

/** `GET …/needs-sign-in` — the imports this person started that wait for their new sign-in. */
export async function pausedImportsOf(c: Context<{ Variables: AuthVariables }>, subject: "camper" | "staff"): Promise<{ id: string; fileName: string; pausedAt: Date | null }[]> {
  const list = await listImportsNeedingSignIn(c.get("session").personId);
  return list.filter((r) => r.subject === subject).map((r) => ({ id: r._id, fileName: r.fileName, pausedAt: r.pausedAt }));
}
