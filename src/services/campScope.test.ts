import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HANDLED, PASSTHROUGH, SCOPED, scopeBulkOp, scopeDoc, scopeDocs, scopeFilter, scopeIndexKeys, scopeIndexOptions, scopeUpdate } from "./campScope";

describe("SCOPED", () => {
  test("lists the real collections the app writes campId on", () => {
    for (const name of ["participants", "bedrooms", "categories", "transports", "teams", "scores", "schedule_roles", "schedule_events", "prep_sections", "instructions", "occurrences", "medicationDoses", "gallery", "settings", "checkinLog", "camperChangeLog", "camperLookups", "camperImports", "ai_usage", "sms_usage"]) {
      expect(SCOPED.has(name)).toBe(true);
    }
    for (const name of ["sessions", "camps", "seeds", "camperImportDictionary", "files", "userCampState"]) {
      expect(SCOPED.has(name)).toBe(false);
    }
  });
});

describe("scopeFilter", () => {
  test("merges campId into a plain filter", () => {
    expect(scopeFilter({ active: true }, "c1")).toEqual({ campId: "c1", active: true });
  });
  test("merges campId into an empty/undefined filter", () => {
    expect(scopeFilter(undefined, "c1")).toEqual({ campId: "c1" });
    expect(scopeFilter({}, "c1")).toEqual({ campId: "c1" });
  });
  test("wraps in $and when the filter already has $or", () => {
    const filter = { $or: [{ a: 1 }, { b: 2 }] };
    expect(scopeFilter(filter, "c1")).toEqual({ $and: [{ campId: "c1" }, filter] });
  });
  test("wraps in $and when the filter already has $and", () => {
    const filter = { $and: [{ a: 1 }] };
    expect(scopeFilter(filter, "c1")).toEqual({ $and: [{ campId: "c1" }, filter] });
  });
  test("wraps in $and when the filter already has $nor", () => {
    const filter = { $nor: [{ a: 1 }] };
    expect(scopeFilter(filter, "c1")).toEqual({ $and: [{ campId: "c1" }, filter] });
  });
  test("wraps in $and when the filter already names campId itself (never shadowed)", () => {
    const filter = { campId: "other" };
    expect(scopeFilter(filter, "c1")).toEqual({ $and: [{ campId: "c1" }, filter] });
  });
});

describe("scopeDoc / scopeDocs", () => {
  test("stamps campId on a fresh document", () => {
    expect(scopeDoc({ name: "a" }, "c1")).toEqual({ name: "a", campId: "c1" });
  });
  test("never overrides an explicit campId", () => {
    expect(scopeDoc({ name: "a", campId: "explicit" }, "c1")).toEqual({ name: "a", campId: "explicit" });
  });
  test("stamps every document of insertMany", () => {
    expect(scopeDocs([{ a: 1 }, { a: 2, campId: "kept" }], "c1")).toEqual([
      { a: 1, campId: "c1" },
      { a: 2, campId: "kept" },
    ]);
  });
});

describe("scopeUpdate", () => {
  test("leaves a non-upsert update untouched", () => {
    const update = { $set: { a: 1 } };
    expect(scopeUpdate(update, false, "c1")).toBe(update);
  });
  test("merges campId into $setOnInsert on upsert", () => {
    expect(scopeUpdate({ $set: { a: 1 }, $setOnInsert: { b: 2 } }, true, "c1")).toEqual({ $set: { a: 1 }, $setOnInsert: { b: 2, campId: "c1" } });
  });
  test("creates $setOnInsert when the update has none, on upsert", () => {
    expect(scopeUpdate({ $set: { a: 1 } }, true, "c1")).toEqual({ $set: { a: 1 }, $setOnInsert: { campId: "c1" } });
  });
  test("never overrides an explicit campId already in $setOnInsert", () => {
    expect(scopeUpdate({ $setOnInsert: { campId: "explicit" } }, true, "c1")).toEqual({ $setOnInsert: { campId: "explicit" } });
  });
  test("leaves a pipeline (array) update untouched even on upsert", () => {
    const update = [{ $set: { a: 1 } }];
    expect(scopeUpdate(update, true, "c1")).toBe(update);
  });
});

describe("scopeIndexKeys / scopeIndexOptions", () => {
  test("prepends campId:1 to the index keys", () => {
    expect(scopeIndexKeys({ name: 1 })).toEqual({ campId: 1, name: 1 });
  });
  test("prefixes an explicit index name", () => {
    expect(scopeIndexOptions({ unique: true, name: "scheduled_unique" })).toEqual({ unique: true, name: "campId_1_scheduled_unique" });
  });
  test("leaves options without a name untouched", () => {
    const opts = { unique: true };
    expect(scopeIndexOptions(opts)).toBe(opts);
  });
  test("leaves undefined options untouched", () => {
    expect(scopeIndexOptions(undefined)).toBeUndefined();
  });
});

describe("scopeBulkOp", () => {
  test("stamps insertOne.document", () => {
    expect(scopeBulkOp({ insertOne: { document: { a: 1 } } }, "c1")).toEqual({ insertOne: { document: { a: 1, campId: "c1" } } });
  });
  test("scopes updateOne's filter and, on upsert, $setOnInsert", () => {
    expect(scopeBulkOp({ updateOne: { filter: { a: 1 }, update: { $set: { b: 2 } }, upsert: true } }, "c1")).toEqual({
      updateOne: { filter: { campId: "c1", a: 1 }, update: { $set: { b: 2 }, $setOnInsert: { campId: "c1" } }, upsert: true },
    });
  });
  test("scopes updateMany's filter", () => {
    expect(scopeBulkOp({ updateMany: { filter: { a: 1 }, update: { $set: { b: 2 } } } }, "c1")).toEqual({
      updateMany: { filter: { campId: "c1", a: 1 }, update: { $set: { b: 2 } } },
    });
  });
  test("scopes replaceOne's filter and stamps the replacement", () => {
    expect(scopeBulkOp({ replaceOne: { filter: { a: 1 }, replacement: { b: 2 } } }, "c1")).toEqual({
      replaceOne: { filter: { campId: "c1", a: 1 }, replacement: { b: 2, campId: "c1" } },
    });
  });
  test("scopes deleteOne's and deleteMany's filter", () => {
    expect(scopeBulkOp({ deleteOne: { filter: { a: 1 } } }, "c1")).toEqual({ deleteOne: { filter: { campId: "c1", a: 1 } } });
    expect(scopeBulkOp({ deleteMany: { filter: { a: 1 } } }, "c1")).toEqual({ deleteMany: { filter: { campId: "c1", a: 1 } } });
  });
});

// ── coverage guard ───────────────────────────────────────────────────────────
// Every `.collection(...).method(` chain found anywhere in the source tree
// (excluding tests) must be a method the scoped wrapper either rewrites
// (HANDLED, see ../db.ts) or explicitly passes through untouched (PASSTHROUGH).
// A newly-used Collection method that lands in neither set is a real gap: it
// would silently ignore campId. Additionally: known `= db.collection(...)` /
// `= (await getDb()).collection(...)` variable assignments are checked for the
// same thing by listing, by hand, the methods called on them (see below).

const ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "scripts"];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function collectionMethodNames(): Set<string> {
  const names = new Set<string>();
  const re = /\.collection\([^)]*\)\s*\.\s*([A-Za-z]+)\(/g;
  for (const dir of SCAN_DIRS) {
    for (const file of listTsFiles(join(ROOT, dir))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(re)) names.add(m[1]!);
    }
  }
  return names;
}

describe("scoped wrapper coverage guard", () => {
  test("every `.collection(...).method(...)` chain in the source tree is handled or an acknowledged passthrough", () => {
    const found = collectionMethodNames();
    expect(found.size).toBeGreaterThan(0); // sanity: the regex actually matched something
    const missing = [...found].filter((m) => !HANDLED.has(m) && !PASSTHROUGH.has(m));
    expect(missing).toEqual([]);
  });

  // `= db.collection(...)` / `= (await getDb()).collection(...)` variable assignments found by hand
  // (grep -rn '= db\.collection(\|= (await getDb())\.collection(' src scripts):
  //   src/models/cleanup.ts:280   const col = db.collection("camperImportDictionary")  → .countDocuments (unscoped collection, still covered)
  //   scripts/seed-medications.ts:59  const campers = db.collection("campers")          → .find, .updateOne (both HANDLED)
  test("methods used on named collection variables are all handled or passthrough", () => {
    const usedOnVariables = ["countDocuments", "find", "updateOne"];
    for (const m of usedOnVariables) expect(HANDLED.has(m) || PASSTHROUGH.has(m)).toBe(true);
  });
});
