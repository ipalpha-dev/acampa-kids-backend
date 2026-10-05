import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Use: bun run scripts/dryRunImports.ts <csv> [...]");

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const sourceName = process.env.MONGODB_DB ?? "camping";
const dryName = `${sourceName}_dryrun_${Date.now()}_${randomUUID().slice(0, 8)}`;
const client = new MongoClient(uri);
await client.connect();
const source = client.db(sourceName);
const dry = client.db(dryName);
// the team's names are read live from IPAlpha (IPALPHA_* env required, as in the API)
const lookupCollections = ["bedrooms", "transports", "teams", "categories", "participants", "camps", "camperImportDictionary"];
let closeModelDb: (() => Promise<void>) | null = null;

try {
  const existing = new Set((await source.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name));
  for (const name of lookupCollections) {
    if (!existing.has(name)) continue;
    const docs = await source.collection(name).find().toArray();
    if (docs.length) await dry.collection(name).insertMany(docs);
  }
  process.env.MONGODB_DB = dryName;
  const [{ analyzeStaffImport }, { analyzeCamperImport }] = await Promise.all([
    import("../src/services/staffImport"),
    import("../src/services/camperImport"),
  ]);
  const { getImportAiStats, resetImportAiStats } = await import("../src/services/importAi");
  closeModelDb = (await import("../src/db")).closeDb;

  for (const input of files) {
    const started = Date.now();
    resetImportAiStats();
    const path = resolve(input);
    const bytes = new Uint8Array(await readFile(path));
    const staff = /equipe|staff|volunt/i.test(basename(path));
    const importId = `dryrun-${randomUUID()}`;
    // Single smart pass: the analysis now runs to the end whenever the
    // identity columns were matched, exactly like the UI does.
    const result = staff
      ? await analyzeStaffImport({ data: bytes, fileName: basename(path), importId })
      : await analyzeCamperImport({ data: bytes, fileName: basename(path), fileType: "text/csv", importId });
    const reviewKinds = Object.fromEntries([...new Set(result.reviews.map((r) => r.kind))].map((kind) => [kind, result.reviews.filter((r) => r.kind === kind).length]));
    const createdItemCounts = Object.fromEntries([...new Set(result.createdItems.map((item) => item.kind))].map((kind) => [kind, result.createdItems.filter((item) => item.kind === kind).length]));
    console.log(JSON.stringify({
      file: basename(path), subject: staff ? "staff" : "camper", status: result.status,
      columns: result.columns.map((c) => ({ source: c.source, target: c.target, confidence: c.confidence, samples: c.samples })),
      previewRows: result.preview.length, skippedRows: result.skipped.length,
      reviews: reviewKinds, createdItemCounts,
      createdItemSamples: result.createdItems.slice(0, 20).map((x) => ({ kind: x.kind, label: x.label })),
      dictionarySamples: result.dictionaries
        .filter((entry) => entry.kind !== "column" && (entry.raw !== entry.label || entry.value == null))
        .slice(0, 30)
        .map((entry) => ({ field: entry.field, raw: entry.raw, canonical: entry.label, matched: entry.value != null })),
      previewSamples: result.preview.slice(0, 5).map((row) => ({ row: row.row, sex: row.sex, active: row.active, roomRole: row.roomRole })),
      ai: getImportAiStats(),
      durationMs: Date.now() - started,
      panic: result.panicMessage,
    }, null, 2));
  }
} finally {
  await closeModelDb?.();
  if (dry.databaseName === dryName && dryName.startsWith(`${sourceName}_dryrun_`)) await dry.dropDatabase();
  await client.close();
}

// Some transitive SDKs keep idle timers alive even after both Mongo clients
// are closed. This is a one-shot diagnostic command, so exit after cleanup.
process.exit(0);
