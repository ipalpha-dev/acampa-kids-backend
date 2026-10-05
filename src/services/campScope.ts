/**
 * Pure helpers behind the scoped `Db` proxy (see ../db.ts). Kept dependency-free
 * (no mongodb import needed beyond ambient types) so they are trivial to unit
 * test without a real database.
 */

export const SCOPED = new Set([
  "participants",
  "bedrooms",
  "categories",
  "transports",
  "teams",
  "scores",
  "schedule_roles",
  "schedule_events",
  "prep_sections",
  "instructions",
  "occurrences",
  "medicationDoses",
  "gallery",
  "settings",
  "checkinLog",
  "camperChangeLog",
  "camperLookups",
  "camperImports",
  "ai_usage",
  "sms_usage",
]);

export function isScoped(name: string): boolean {
  return SCOPED.has(name);
}

export type AnyFilter = Record<string, unknown>;
export type AnyDoc = Record<string, unknown>;
export type AnyUpdate = Record<string, unknown> | unknown[];

/** filters carrying one of these already shape the query — merging campId in naively could shadow it */
const RISKY_FILTER_KEYS = ["$or", "$and", "$nor", "campId"];

/**
 * `filter = { campId, ...filter }` normally; when the filter already uses
 * `$or` / `$and` / `$nor`, or already names `campId` itself, wrap both sides
 * in an `$and` instead so neither shadows the other.
 */
export function scopeFilter(filter: AnyFilter | undefined, campId: string): AnyFilter {
  const f = filter ?? {};
  const risky = RISKY_FILTER_KEYS.some((k) => k in f);
  return risky ? { $and: [{ campId }, f] } : { campId, ...f };
}

/** Stamps `campId` on a fresh document — an explicit `campId` already on it is never overridden. */
export function scopeDoc<T extends AnyDoc>(doc: T, campId: string): T & { campId: string } {
  if (Object.prototype.hasOwnProperty.call(doc, "campId")) return doc as T & { campId: string };
  return { ...doc, campId };
}

export function scopeDocs<T extends AnyDoc>(docs: T[], campId: string): (T & { campId: string })[] {
  return docs.map((d) => scopeDoc(d, campId));
}

/**
 * An upsert must stamp `campId` on the document it MAY insert: merged into
 * `$setOnInsert` (an existing one is preserved) so a matching document is
 * never touched, only a freshly-inserted one gets the field. Pipeline updates
 * (an array) can't carry `$setOnInsert` — left untouched (no upsert in the
 * codebase pairs one with an upsert today).
 */
export function scopeUpdate(update: AnyUpdate, upsert: boolean, campId: string): AnyUpdate {
  if (!upsert || Array.isArray(update)) return update;
  const u = update as AnyDoc;
  const setOnInsert = (u.$setOnInsert as AnyDoc | undefined) ?? {};
  if (Object.prototype.hasOwnProperty.call(setOnInsert, "campId")) return u;
  return { ...u, $setOnInsert: { ...setOnInsert, campId } };
}

/** `createIndex(keys, opts)` → every index (unique ones included) becomes per camp. */
export function scopeIndexKeys(keys: Record<string, unknown>): Record<string, unknown> {
  return { campId: 1, ...keys };
}

export function scopeIndexOptions<T extends Record<string, unknown> | undefined>(opts: T): T {
  const name = opts && typeof opts.name === "string" ? opts.name : null;
  if (!name) return opts;
  return { ...opts, name: `campId_1_${name}` };
}

interface BulkOp {
  insertOne?: { document: AnyDoc };
  updateOne?: { filter: AnyFilter; update: AnyUpdate; upsert?: boolean };
  updateMany?: { filter: AnyFilter; update: AnyUpdate; upsert?: boolean };
  replaceOne?: { filter: AnyFilter; replacement: AnyDoc; upsert?: boolean };
  deleteOne?: { filter: AnyFilter };
  deleteMany?: { filter: AnyFilter };
}

/** Patches one `bulkWrite` operation in place (returns a new object; the input is never mutated). */
export function scopeBulkOp(op: BulkOp, campId: string): BulkOp {
  if (op.insertOne) return { insertOne: { document: scopeDoc(op.insertOne.document, campId) } };
  if (op.updateOne) {
    const { filter, update, upsert } = op.updateOne;
    return { updateOne: { filter: scopeFilter(filter, campId), update: scopeUpdate(update, !!upsert, campId), ...(upsert !== undefined ? { upsert } : {}) } };
  }
  if (op.updateMany) {
    const { filter, update, upsert } = op.updateMany;
    return { updateMany: { filter: scopeFilter(filter, campId), update: scopeUpdate(update, !!upsert, campId), ...(upsert !== undefined ? { upsert } : {}) } };
  }
  if (op.replaceOne) {
    const { filter, replacement, upsert } = op.replaceOne;
    return { replaceOne: { filter: scopeFilter(filter, campId), replacement: scopeDoc(replacement, campId), ...(upsert !== undefined ? { upsert } : {}) } };
  }
  if (op.deleteOne) return { deleteOne: { filter: scopeFilter(op.deleteOne.filter, campId) } };
  if (op.deleteMany) return { deleteMany: { filter: scopeFilter(op.deleteMany.filter, campId) } };
  return op;
}

/**
 * Methods the scoped wrapper rewrites (filter/document/index patched).
 * `HANDLED` is what the coverage-guard test checks call sites against.
 */
export const HANDLED = new Set([
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct",
  "aggregate",
  "insertOne",
  "insertMany",
  "bulkWrite",
  "createIndex",
]);

/**
 * Methods intentionally left untouched — index / cursor / admin operations
 * that operate by name or already work collection-wide. Real `Collection`
 * methods not named here still pass through (see `wrapCollection` in
 * ../db.ts), this set only documents the ones we KNOW the codebase calls
 * directly on a `.collection(...)` chain, for the coverage-guard test.
 */
export const PASSTHROUGH = new Set(["dropIndex", "createIndexes", "indexes", "listIndexes", "watch", "drop", "rename", "options", "isCapped", "stats"]);
