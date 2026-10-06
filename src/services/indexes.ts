import { MongoServerError, type Collection, type CreateIndexesOptions, type Document, type IndexSpecification } from "mongodb";
import { isScoped } from "./campScope";
import { markIndexFailed } from "./readiness";

/**
 * Decision 91 — indexes never block boot. Every boot-time index goes through
 * `ensureIndex`: an index the SERVER refuses (duplicate keys under a unique
 * index, an existing index with the same name and other keys / options, …) is
 * logged by NAME and error CODE only, marked on `/ready` as
 * `checks.indexes: "degraded"` (still 200 — the app keeps serving) and never
 * retried in a loop. Only a client-side failure (Mongo unreachable) is
 * rethrown, so the boot retry waits for Mongo itself.
 *
 * Never log the error message: a duplicate-key error carries `keyValue` /
 * "dup key: { … }" — document values (person ids, names on old documents).
 *
 * An index whose KEYS changed carries a NEW explicit name (`*_v2`), so it never
 * collides with an older index of the same auto-generated name.
 */

/** The name Mongo would give the index (scoped collections get the `campId_1_` prefix — see campScope). */
export function indexName(collectionName: string, keys: Record<string, unknown>, opts?: { name?: string }): string {
  const scoped = isScoped(collectionName);
  if (opts?.name) return scoped ? `campId_1_${opts.name}` : opts.name;
  const auto = Object.entries(keys).map(([k, v]) => `${k}_${String(v)}`).join("_");
  return scoped ? `campId_1_${auto}` : auto;
}

/** Creates one index; a server-side refusal degrades `/ready` instead of failing boot. */
export async function ensureIndex(collection: Collection<Document>, keys: Record<string, 1 | -1>, opts?: CreateIndexesOptions): Promise<boolean> {
  const name = indexName(collection.collectionName, keys, opts);
  try {
    await collection.createIndex(keys as IndexSpecification, opts ?? {});
    return true;
  } catch (err) {
    if (!(err instanceof MongoServerError)) throw err; // Mongo itself is down → boot retries
    const code = typeof err.code === "number" ? err.code : "?";
    const codeName = typeof err.codeName === "string" ? err.codeName : "MongoServerError";
    markIndexFailed(`${collection.collectionName}.${name}`);
    console.error(`[indexes] ${collection.collectionName}.${name} not created (code ${code} ${codeName}) — serving without it; /ready reports indexes: degraded`);
    return false;
  }
}
