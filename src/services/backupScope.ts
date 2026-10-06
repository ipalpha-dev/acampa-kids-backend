/**
 * What `scripts/backup.ts` dumps and restores — an explicit ALLOWLIST of the
 * collections of this version (decision 90: the old Acampa data is dropped at
 * cut-over, never exported). A collection that is not named here — a leftover
 * of an older version (`campers`, `staff`, `users`, `camperImports`,
 * `healthQueue`…), a new collection nobody reviewed yet, sessions / sign-ins
 * in flight / webhook delivery ids / import jobs — is never read by the
 * backup and never written by a restore. A new collection = a new entry here
 * (after checking it holds no names, contacts, health or tokens).
 */
export const BACKUP_COLLECTIONS: readonly string[] = [
  "camps",
  "settings",
  "seeds",
  "categories",
  "participants",
  "importConflicts",
  "userCampState",
  "bedrooms",
  "teams",
  "transports",
  "scores",
  "schedule_roles",
  "schedule_events",
  "prep_sections",
  "instructions",
  "occurrences",
  "medicationDoses",
  "gallery",
  "files",
  "checkinLog",
  "camperChangeLog",
  "camperLookups",
  "ai_usage",
  "sms_usage",
];

const ALLOWED: ReadonlySet<string> = new Set(BACKUP_COLLECTIONS);

export function isBackupCollection(name: string): boolean {
  return ALLOWED.has(name);
}

/** The collections a backup dumps: the allowlisted ones present in the database, sorted. */
export function backupCollectionNames(existing: readonly string[]): string[] {
  return existing.filter(isBackupCollection).sort();
}

/** The part of a backup file a restore writes: allowlisted collections only (anything else is skipped and reported). */
export function restorableCollections<T>(collections: Record<string, T>): { keep: [string, T][]; skipped: string[] } {
  const keep: [string, T][] = [];
  const skipped: string[] = [];
  for (const [name, docs] of Object.entries(collections)) {
    if (isBackupCollection(name)) keep.push([name, docs]);
    else skipped.push(name);
  }
  return { keep, skipped };
}

/** Fields never dumped even from an allowlisted collection (secrets: the camp-delete code hash). */
const STRIPPED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  camps: ["deleteOtp"],
};

/** Removes the never-dumped fields of one document in place. */
export function stripBackupDoc(collection: string, doc: Record<string, unknown>): Record<string, unknown> {
  for (const field of STRIPPED_FIELDS[collection] ?? []) delete doc[field];
  return doc;
}
