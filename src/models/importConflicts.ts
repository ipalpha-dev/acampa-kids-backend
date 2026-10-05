import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { ImportField, ParticipantKind } from "./participants";
import { ensureIndex } from "../services/indexes";

/**
 * `importConflicts` (decision 78): an import value that was NOT written because
 * a person had changed that camp field by hand since the last import. One entry
 * per (person, field) per camp — a newer import replaces the older entry. Holds
 * ids, the field key and the two camp-ops values (room / vehicle / team ids, the
 * room role, or the camp's own text fields) — never a name or any IPAlpha person
 * data. Gone once the coordenação decides ("Aplicar valor da importação" /
 * "Manter o atual"), or when the row stops existing. Scoped per camp.
 */
export const IMPORT_CONFLICTS = "importConflicts";

export interface ImportConflict {
  _id: string;
  personId: string;
  kind: ParticipantKind;
  field: ImportField;
  importId: string;
  importValue: string | null;
  currentValue: string | null;
  createdAt: Date;
}

function toConflict(doc: Record<string, unknown>): ImportConflict {
  return {
    _id: String(doc._id),
    personId: doc.personId as string,
    kind: doc.kind as ParticipantKind,
    field: doc.field as ImportField,
    importId: doc.importId as string,
    importValue: typeof doc.importValue === "string" ? doc.importValue : null,
    currentValue: typeof doc.currentValue === "string" ? doc.currentValue : null,
    createdAt: doc.createdAt as Date,
  };
}

/** Records (or replaces) the open decision of `personId` + `field`. */
export async function upsertImportConflict(input: Omit<ImportConflict, "_id" | "createdAt">): Promise<void> {
  const db = await getDb();
  await db.collection(IMPORT_CONFLICTS).updateOne(
    { personId: input.personId, field: input.field },
    { $set: { kind: input.kind, importId: input.importId, importValue: input.importValue, currentValue: input.currentValue, createdAt: new Date() } },
    { upsert: true },
  );
}

export async function listImportConflicts(kind?: ParticipantKind): Promise<ImportConflict[]> {
  const db = await getDb();
  const docs = await db.collection(IMPORT_CONFLICTS).find(kind ? { kind } : {}).sort({ createdAt: 1, personId: 1, field: 1 }).toArray();
  return docs.map((d) => toConflict(d as Record<string, unknown>));
}

export async function findImportConflicts(ids: string[]): Promise<ImportConflict[]> {
  const oids = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (oids.length === 0) return [];
  const db = await getDb();
  const docs = await db.collection(IMPORT_CONFLICTS).find({ _id: { $in: oids } }).toArray();
  return docs.map((d) => toConflict(d as Record<string, unknown>));
}

/** The open decision of one field (if any) is gone — e.g. the import value was written after all. */
export async function deleteImportConflict(personId: string, field: string): Promise<void> {
  const db = await getDb();
  await db.collection(IMPORT_CONFLICTS).deleteOne({ personId, field });
}

export async function deleteImportConflictsById(ids: string[]): Promise<number> {
  const oids = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (oids.length === 0) return 0;
  const db = await getDb();
  return (await db.collection(IMPORT_CONFLICTS).deleteMany({ _id: { $in: oids } })).deletedCount;
}

export async function ensureImportConflictIndexes(): Promise<void> {
  const db = await getDb();
  await ensureIndex(db.collection(IMPORT_CONFLICTS), { personId: 1, field: 1 }, { unique: true });
  await ensureIndex(db.collection(IMPORT_CONFLICTS), { kind: 1, createdAt: 1 });
}
