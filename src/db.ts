import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import { config } from "./config";
import { currentCampId } from "./services/campContext";
import { isScoped, scopeBulkOp, scopeDoc, scopeDocs, scopeFilter, scopeIndexKeys, scopeIndexOptions, scopeUpdate } from "./services/campScope";

/** created on first use (not at import) so tests can point `config.mongoUri` at a throwaway server first */
let client: MongoClient | null = null;

let realDb: Db | null = null;

/** The real, unscoped database — for the global registry (`camps`) and anything that must see every camp at once (boot migration, backups). */
export async function rawDb(): Promise<Db> {
  if (!realDb) {
    client ??= new MongoClient(config.mongoUri);
    await client.connect();
    realDb = client.db(config.dbName);
  }
  return realDb;
}

type Handler = (target: Collection<Document>, campId: string, ...args: never[]) => unknown;

const HANDLERS: Record<string, Handler> = {
  find: (t, id, filter, opts) => t.find(scopeFilter(filter as never, id) as never, opts as never),
  findOne: (t, id, filter, opts) => t.findOne(scopeFilter(filter as never, id) as never, opts as never),
  findOneAndUpdate: (t, id, filter, update, opts) =>
    t.findOneAndUpdate(scopeFilter(filter as never, id) as never, scopeUpdate(update as never, !!(opts as { upsert?: boolean } | undefined)?.upsert, id) as never, opts as never),
  findOneAndReplace: (t, id, filter, replacement, opts) => {
    const upsert = !!(opts as { upsert?: boolean } | undefined)?.upsert;
    return t.findOneAndReplace(scopeFilter(filter as never, id) as never, (upsert ? scopeDoc(replacement as never, id) : replacement) as never, opts as never);
  },
  findOneAndDelete: (t, id, filter, opts) => t.findOneAndDelete(scopeFilter(filter as never, id) as never, opts as never),
  updateOne: (t, id, filter, update, opts) =>
    t.updateOne(scopeFilter(filter as never, id) as never, scopeUpdate(update as never, !!(opts as { upsert?: boolean } | undefined)?.upsert, id) as never, opts as never),
  updateMany: (t, id, filter, update, opts) =>
    t.updateMany(scopeFilter(filter as never, id) as never, scopeUpdate(update as never, !!(opts as { upsert?: boolean } | undefined)?.upsert, id) as never, opts as never),
  replaceOne: (t, id, filter, replacement, opts) => {
    const upsert = !!(opts as { upsert?: boolean } | undefined)?.upsert;
    return t.replaceOne(scopeFilter(filter as never, id) as never, (upsert ? scopeDoc(replacement as never, id) : replacement) as never, opts as never);
  },
  deleteOne: (t, id, filter, opts) => t.deleteOne(scopeFilter(filter as never, id) as never, opts as never),
  deleteMany: (t, id, filter, opts) => t.deleteMany(scopeFilter(filter as never, id) as never, opts as never),
  countDocuments: (t, id, filter, opts) => t.countDocuments(scopeFilter(filter as never, id) as never, opts as never),
  estimatedDocumentCount: (t, id) => t.countDocuments({ campId: id } as never),
  distinct: (t, id, key, filter, opts) => t.distinct(key as never, scopeFilter(filter as never, id) as never, opts as never),
  aggregate: (t, id, pipeline, opts) => t.aggregate([{ $match: { campId: id } }, ...((pipeline as unknown[] | undefined) ?? [])] as never, opts as never),
  insertOne: (t, id, doc, opts) => t.insertOne(scopeDoc(doc as never, id) as never, opts as never),
  insertMany: (t, id, docs, opts) => t.insertMany(scopeDocs((docs as never[]) ?? [], id) as never, opts as never),
  bulkWrite: (t, id, ops, opts) => t.bulkWrite(((ops as never[]) ?? []).map((op) => scopeBulkOp(op as never, id)) as never, opts as never),
  createIndex: (t, id, keys, opts) => t.createIndex(scopeIndexKeys(keys as never) as never, scopeIndexOptions(opts as never) as never),
};

/** Wraps one real `Collection` so every call in `HANDLERS` is scoped to `currentCampId()`, read at CALL time; everything else passes straight through. */
function wrapCollection<T extends Document = Document>(real: Collection<T>): Collection<T> {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const handler = HANDLERS[prop];
        if (handler) return (...args: never[]) => handler(target as unknown as Collection<Document>, currentCampId(), ...args);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Collection<T>;
}

let scopedDb: Db | null = null;

/**
 * The scoped `Db`: `collection(name)` returns the real collection for names
 * outside `SCOPED`, and a wrapper that filters/stamps every call with
 * `currentCampId()` for names inside it (see ./services/campScope.ts).
 * A single camp behaves exactly like the old unscoped `Db`.
 */
export async function getDb(): Promise<Db> {
  const real = await rawDb();
  if (!scopedDb) {
    scopedDb = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "collection") {
          return <T extends Document = Document>(name: string, options?: unknown) => {
            const col = (target.collection as (n: string, o?: unknown) => Collection<T>)(name, options);
            return isScoped(name) ? wrapCollection(col) : col;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
  }
  return scopedDb;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    realDb = null;
    scopedDb = null;
  }
}
