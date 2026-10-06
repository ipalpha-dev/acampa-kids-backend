/**
 * Full backup & restore of the camping database — everything lives in this one
 * file; no server code is touched. Run it with Bun from `backend/`.
 *
 *   bun run scripts/backup.ts                        make a backup
 *   bun run scripts/backup.ts list <zip>             inspect a backup file
 *   bun run scripts/backup.ts restore <zip>          restore (asks first)
 *       --with-photos   also restore the photo album (off by default)
 *       --yes           skip the RESTORE confirmation prompt
 *
 * BACKUP FILE (one zip):
 *   acampa-backup-YYYYMMDD-HHmmss.zip
 *   ├── backup.xlsx   the ALLOWLISTED collections (src/services/backupScope.ts),
 *   │                 one tab per collection, all with their ids. Anything
 *   │                 else in the database — sessions, sign-ins in flight,
 *   │                 import jobs, a leftover of an older version — is never
 *   │                 read (decision 90: old Acampa data is never exported)
 *   └── imagens.zip   every file on the FILES_DIR volume (editor images,
 *                     album photos, thumbnails)
 *
 * The Excel tabs are human-readable (id first, then the document fields), but
 * the source of truth for the restore is the `_doc` column of each row: the
 * exact document serialized as JSON with Mongo types preserved ($oid, $date,
 * $binary). Very long documents are split across `_doc`, `_doc.2`, `_doc.3`…
 * because an Excel cell holds at most 32 767 characters.
 *
 * FORMAT VERSIONING
 * -----------------
 * `BACKUP_VERSION` below is the version of this backup strategy. It is shown
 * in the app's "Sobre" page (frontend/src/pages/admin/AboutPage.tsx — keep the
 * two numbers in sync). The `_backup` tab records the version inside every
 * file. When the app's data model changes (a collection or field is renamed,
 * a field gains a new shape…), bump BACKUP_VERSION and add one entry to
 * MIGRATIONS mapping the previous version onto the new one — old backup files
 * then restore into the new app unchanged (example: `3: (b) => { b.collections.x = … }`).
 * A restore only ever writes the allowlisted collections.
 */
import { Binary, ObjectId, type Db } from "mongodb";
import { inflateRawSync } from "node:zlib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { config } from "../src/config";
import { closeDb, rawDb } from "../src/db";
import { SCOPED } from "../src/services/campScope";
import { backupCollectionNames, restorableCollections, stripBackupDoc } from "../src/services/backupScope";
import pkg from "../package.json";

/** the version of the backup strategy — mirror this in the app's "Sobre" page */
export const BACKUP_VERSION = 3;

/**
 * v3 = people live in IPAlpha (CONTRACTS_ACAMPA §15): `participants` (camp ops
 * keyed by personId) replace campers / staff, `users` is gone. A v1 / v2 file
 * carries person data Acampa must not hold any more and has no person ids, so
 * it cannot be restored into v3 (decision 33: no migration ceremony).
 */
const FIRST_RESTORABLE_VERSION = 3;

const META_SHEET = "_backup";
const XLSX_NAME = "backup.xlsx";
const IMAGES_NAME = "imagens.zip";
const BACKUPS_DIR = join(import.meta.dir, "../data/backups");
/** Excel hard limit per cell, minus headroom */
const CELL_CHUNK = 32_000;
/** display columns are cut short — the full value always lives in `_doc` */
const DISPLAY_LIMIT = 400;
const INSERT_CHUNK = 500;

/** one parsed backup file, already migrated to BACKUP_VERSION */
interface Backup {
  version: number;
  appVersion: string;
  createdAt: string;
  collections: Record<string, Doc[]>;
}
type Doc = Record<string, unknown>;

/**
 * Version n → n+1 transforms. Key = the OLD version; the function rewrites the
 * backup in place so it matches the NEXT version's shape. Restore walks these
 * from the file's version up to BACKUP_VERSION. Async because a migration may
 * need to read the target database (e.g. v1 → v2 needs the active camp's id).
 */
const MIGRATIONS: Record<number, (backup: Backup, db: Db) => void | Promise<void>> = {};

async function migrate(backup: Backup, db: Db): Promise<Backup> {
  if (backup.version > BACKUP_VERSION) {
    throw new Error(
      `backup format v${backup.version} is NEWER than this script (v${BACKUP_VERSION}) — restore it with the app version that made it.`,
    );
  }
  if (backup.version < FIRST_RESTORABLE_VERSION) {
    throw new Error(`backup format v${backup.version} predates IPAlpha people (v${FIRST_RESTORABLE_VERSION}): it holds person data Acampa no longer keeps and cannot be restored.`);
  }
  let v = backup.version;
  while (v < BACKUP_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration path from backup format v${v} to v${v + 1}.`);
    await step(backup, db);
    backup.version = ++v;
  }
  return backup;
}

// ------------------------------------------------- mongo ⇄ JSON type mapping --
/** Date/ObjectId/Binary → tagged JSON objects, recursively (like Mongo's extended JSON) */
function encodeValue(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Binary) return { $binary: Buffer.from(value.buffer).toString("base64"), $subtype: value.sub_type };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeValue(v);
    return out;
  }
  return value;
}

/** the tagged JSON objects back into real Mongo types */
function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      if (typeof obj.$date === "string") {
        const d = new Date(obj.$date);
        if (!Number.isNaN(d.getTime())) return d;
      }
      if (typeof obj.$oid === "string" && /^[0-9a-f]{24}$/.test(obj.$oid)) return new ObjectId(obj.$oid);
      if (typeof obj.$binary === "string") return new Binary(Buffer.from(obj.$binary, "base64"), (obj.$subtype as number) ?? 0);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = decodeValue(v);
    return out;
  }
  return value;
}

const encodeDoc = (doc: Doc): string => JSON.stringify(encodeValue(doc));
const decodeDoc = (json: string): Doc => decodeValue(JSON.parse(json)) as Doc;

// ------------------------------------------------------------------- zip io --
let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Minimal ZIP writer — entries are STORED (no compression): the payload is
 * JPEG/PNG bytes and the xlsx (already a zip), so compression would buy
 * nothing. Produces standard archives any unzipper understands.
 */
function makeZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const { time, date } = dosDateTime();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBuf.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBuf.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBuf, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + nameBuf.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBuf.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true);
    central.set(nameBuf, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  const parts = [...locals, ...centrals, eocd];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Reads our own archives (stored) and normal zips made by other tools (deflate). */
function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // find the end-of-central-directory record (scan back from the end)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory).");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("corrupt zip: bad central directory entry.");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compSize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(buf.subarray(at + 46, at + 46 + nameLen));
    // local header: jump over it to the data (its own name/extra lens can differ)
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    const data = method === 0 ? raw : method === 8 ? new Uint8Array(inflateRawSync(raw)) : null;
    if (!data) throw new Error(`unsupported zip compression (method ${method}) for ${name}.`);
    if (crc32(data) !== crc) throw new Error(`corrupt zip: crc mismatch for ${name}.`);
    files.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ------------------------------------------------------------------ xlsx io --
type Cell = string | number;

function xmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** 1 → A, 2 → B, 27 → AA… */
function columnName(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(rows: Cell[][]): string {
  const widths: number[] = [];
  const consider = (col: number, value: Cell) => {
    const len = Math.min(String(value).length, 55);
    widths[col] = Math.max(widths[col] ?? 8, len, col === 0 ? 10 : 0);
  };
  rows.slice(0, 100).forEach((row) => row.forEach((c, i) => consider(i, c)));
  const cols =
    widths.length > 0
      ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(w + 2, 9)}" customWidth="1"/>`).join("")}</cols>`
      : "";
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === "" || value === undefined || value === null) return "";
          const ref = `${columnName(c + 1)}${r + 1}`;
          return typeof value === "number" && Number.isFinite(value)
            ? `<c r="${ref}"><v>${value}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${body}</sheetData></worksheet>`;
}

function sanitizeSheetName(name: string, taken: Set<string>): string {
  let sheet = name.replace(/[\\/*?:[\]]/g, "_").slice(0, 31) || "sheet";
  while (taken.has(sheet)) sheet = sheet.slice(0, 28) + `_${taken.size}`;
  taken.add(sheet);
  return sheet;
}

/** hand-built minimal .xlsx: one worksheet per sheet, inline strings only */
function makeXlsx(sheets: { name: string; rows: Cell[][] }[]): Uint8Array {
  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sanitizeSheetName(s.name, taken) }));
  const overrides = named
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("");
  const workbookSheets = named.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const rels = named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`),
    },
    {
      name: "_rels/.rels",
      data: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`),
    },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: new TextEncoder().encode(sheetXml(s.rows)) })),
  ]);
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Reads back exactly what sheetXml() writes (inline strings + plain numbers).
 * Returns each sheet as rows of strings, indexed by column position.
 */
function parseXlsx(buf: Uint8Array): Map<string, string[][]> {
  const files = readZip(buf);
  const decoder = new TextDecoder();
  const workbook = decoder.decode(files.get("xl/workbook.xml")!);
  const sheetNames = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => xmlUnescape(m[1]!));
  const sheets = new Map<string, string[][]>();
  sheetNames.forEach((name, i) => {
    const xml = decoder.decode(files.get(`xl/worksheets/sheet${i + 1}.xml`)!);
    const rows: string[][] = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*)\/?>(?:([\s\S]*?)<\/c>)?/g)) {
        const attrs = cellMatch[1]!;
        const inner = cellMatch[2] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        if (!ref) continue;
        const col = [...ref].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
        const text = cellMatch[0].endsWith("/>") ? "" : (/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        row[col] = xmlUnescape(text);
      }
      rows.push(row);
    }
    sheets.set(name, rows);
  });
  return sheets;
}

// ------------------------------------------------------------ sheet building --
/** what shows in the tab for a field value — short and human; `_doc` keeps the truth */
function displayValue(value: unknown): Cell {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Binary) return `(binary ${value.length()} bytes)`;
  return JSON.stringify(encodeValue(value));
}

function collectionSheet(name: string, docs: Doc[]): { name: string; rows: Cell[][] } {
  // column = every field any document has; id first, the rest alphabetical (stable tabs)
  const fields = new Set<string>();
  for (const doc of docs) for (const key of Object.keys(doc)) fields.add(key);
  const columns = ["_id", ...[...fields].filter((f) => f !== "_id").sort()];
  const rows: Cell[][] = [[...columns.map((f) => (f === "_id" ? "id" : f))]];
  let maxDocLen = 0;
  for (const doc of docs) {
    const row: Cell[] = [];
    for (const field of columns) {
      const shown = displayValue(doc[field]);
      row.push(typeof shown === "string" && shown.length > DISPLAY_LIMIT ? `${shown.slice(0, DISPLAY_LIMIT)}…` : shown);
    }
    // the exact document, chunked when longer than one cell can hold
    const json = encodeDoc(doc);
    maxDocLen = Math.max(maxDocLen, json.length);
    for (let at = 0; at < json.length; at += CELL_CHUNK) row.push(json.slice(at, at + CELL_CHUNK));
    rows.push(row);
  }
  // header for the _doc column(s) — restore looks for these names
  const chunks = Math.max(1, Math.ceil(maxDocLen / CELL_CHUNK));
  rows[0]!.push(...Array.from({ length: chunks }, (_, i) => (i === 0 ? "_doc" : `_doc.${i + 1}`)));
  return { name, rows };
}

function backupFromSheets(sheets: Map<string, string[][]>): Backup {
  const metaRows = sheets.get(META_SHEET) ?? [];
  const meta = new Map(metaRows.slice(1).map((r) => [r[0] ?? "", r[1] ?? ""]));
  const version = Number(meta.get("backupVersion"));
  if (!Number.isFinite(version)) throw new Error(`this is not a camping backup (no backupVersion in the ${META_SHEET} tab).`);
  const backup: Backup = {
    version,
    appVersion: meta.get("appVersion") ?? "?",
    createdAt: meta.get("createdAt") ?? "?",
    collections: {},
  };
  for (const [sheet, rows] of sheets) {
    if (sheet === META_SHEET || rows.length === 0) continue;
    const header = rows[0]!;
    const docCols = header
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h === "_doc" || /^_doc\.\d+$/.test(h))
      .sort((a, b) => (a.h === "_doc" ? -1 : b.h === "_doc" ? 1 : Number(/(\d+)/.exec(a.h)?.[1]) - Number(/(\d+)/.exec(b.h)?.[1])))
      .map(({ i }) => i);
    if (docCols.length === 0) throw new Error(`tab ${sheet} has no _doc column.`);
    backup.collections[sheet] = rows.slice(1).map((row) => decodeDoc(docCols.map((i) => row[i] ?? "").join("")));
  }
  return backup;
}

// ----------------------------------------------------------------- commands --
async function runBackup(camp?: string): Promise<void> {
  const db = await rawDb();
  // allowlist only (decision 90): sessions, sign-ins, import jobs and any older version's collection never leave the database
  const names = backupCollectionNames((await db.listCollections().toArray()).map((c) => c.name));
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  if (camp) console.log(`📎 filtering to camp ${camp} — SCOPED collections only carry this camp's documents; every global collection is dumped in full.`);

  const sheets: { name: string; rows: Cell[][] }[] = [
    {
      name: META_SHEET,
      rows: [["campo", "valor"], ["backupVersion", BACKUP_VERSION], ["appVersion", pkg.version], ["createdAt", now.toISOString()], ["dbName", config.dbName], ["collections", names.join(", ")], ["camp", camp ?? ""]],
    },
  ];
  const images = new Map<string, Uint8Array>();

  for (const name of names) {
    const filter = camp && SCOPED.has(name) ? { campId: camp } : {};
    const docs = ((await db.collection(name).find(filter).sort({ _id: 1 }).toArray()) as unknown as Doc[]).map((doc) => stripBackupDoc(name, doc));
    sheets.push(collectionSheet(name, docs));
    console.log(`  ${name}: ${docs.length} documento(s)`);
  }

  // every file on the volume: editor images, album photos, thumbnails
  await mkdir(config.filesDir, { recursive: true });
  for (const entry of await readdir(config.filesDir)) {
    const bytes = await readFile(join(config.filesDir, entry)).catch(() => null);
    if (bytes && !images.has(entry)) images.set(entry, new Uint8Array(bytes));
  }

  const xlsx = makeXlsx(sheets);
  const imagesZip = makeZip([...images].map(([name, data]) => ({ name, data })));
  const backupZip = makeZip([
    { name: XLSX_NAME, data: xlsx },
    { name: IMAGES_NAME, data: imagesZip },
  ]);
  await mkdir(BACKUPS_DIR, { recursive: true });
  const path = join(BACKUPS_DIR, `acampa-backup-${stamp}.zip`);
  await writeFile(path, backupZip);
  const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
  console.log(`\n✅ ${path}`);
  console.log(`   ${XLSX_NAME}: ${mb(xlsx.length)} · ${IMAGES_NAME}: ${images.size} arquivo(s), ${mb(imagesZip.length)} · total ${mb(backupZip.length)}`);
}

function summarize(backup: Backup): string {
  const collections = Object.entries(backup.collections)
    .map(([name, docs]) => `${name}: ${docs.length}`)
    .join(" · ");
  return `backup format v${backup.version} (app v${backup.appVersion}) — criado em ${backup.createdAt}\n${collections}`;
}

async function runList(zipPath: string): Promise<void> {
  const backup = await loadBackup(zipPath, await rawDb());
  console.log(summarize(backup));
}

async function loadBackup(zipPath: string, db: Db): Promise<Backup> {
  const entries = readZip(new Uint8Array(await readFile(zipPath)));
  const xlsxBuf = entries.get(XLSX_NAME) ?? [...entries.entries()].find(([name]) => name.endsWith(".xlsx"))?.[1];
  if (!xlsxBuf) throw new Error(`${zipPath} has no ${XLSX_NAME} inside.`);
  return migrate(backupFromSheets(parseXlsx(xlsxBuf)), db);
}

async function runRestore(zipPath: string, opts: { withPhotos: boolean; yes: boolean }): Promise<void> {
  const db = await rawDb();
  const backup = await loadBackup(zipPath, db);
  const entries = readZip(new Uint8Array(await readFile(zipPath)));
  const imagesBuf = entries.get(IMAGES_NAME);
  const images = imagesBuf ? readZip(imagesBuf) : new Map<string, Uint8Array>();

  // the photo album is never restored unless asked to
  const galleryDocs = backup.collections["gallery"] ?? [];
  const photoFileIds = new Set(galleryDocs.map((d) => String(d.fileId)));
  const photoIds = new Set(galleryDocs.map((d) => String(d._id)));
  const skipped = opts.withPhotos ? [] : ["gallery"];

  console.log(`📦 ${zipPath}`);
  console.log(summarize(backup));
  if (!opts.withPhotos) console.log(`\n📷 galeria de fotos NÃO será restaurada (${galleryDocs.length} foto(s) no backup; use --with-photos para incluir)`);
  console.log(`\n⚠️  isto APAGA os dados atuais do banco "${config.dbName}" e os substitui pelos do backup.`);

  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Digite RESTORE para confirmar: ');
    rl.close();
    if (answer.trim() !== "RESTORE") {
      console.log("cancelado.");
      return;
    }
  }

  const { keep, skipped: notAllowed } = restorableCollections(backup.collections);
  if (notAllowed.length) console.log(`\n🚫 ignoradas (fora da lista de coleções desta versão): ${notAllowed.join(", ")}`);
  for (const [name, docs] of keep) {
    if (skipped.includes(name)) continue;
    if (name === "files" && !opts.withPhotos) {
      // album photo metadata travels in `files` too — keep those out as well
      const keep = docs.filter((d) => !photoFileIds.has(String(d._id)));
      console.log(`  files: ${keep.length} documento(s) (${docs.length - keep.length} de fotos ignorados)`);
      await db.collection(name).deleteMany({});
      await insertChunks(db, name, keep);
      continue;
    }
    await db.collection(name).deleteMany({});
    await insertChunks(db, name, docs);
    console.log(`  ${name}: ${docs.length} documento(s)`);
  }

  // the image volume: skip album photos + their thumbnails unless --with-photos
  let written = 0;
  await mkdir(config.filesDir, { recursive: true });
  for (const [name, bytes] of images) {
    if (!opts.withPhotos && (photoFileIds.has(name) || (name.startsWith("thumb-") && photoIds.has(name.slice(6))))) continue;
    await writeFile(join(config.filesDir, name), bytes);
    written++;
  }
  console.log(`  arquivos de imagem: ${written} gravado(s)`);
  console.log("\n✅ restore concluído — reinicie o backend para recriar índices e agendamentos.");
}

async function insertChunks(db: Db, name: string, docs: Doc[]): Promise<void> {
  for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
    await db.collection(name).insertMany(docs.slice(i, i + INSERT_CHUNK) as never[]);
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

// --------------------------------------------------------------------- main --
const argv = process.argv.slice(2);
const command = argv[0] === "restore" || argv[0] === "list" ? argv[0] : null;
const args = command ? argv.slice(1) : argv;
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
try {
  if (command === "restore") {
    const zipPath = args.find((a) => !a.startsWith("--"));
    if (!zipPath) throw new Error("usage: bun run scripts/backup.ts restore <arquivo.zip> [--with-photos] [--yes]");
    await runRestore(zipPath, { withPhotos: args.includes("--with-photos"), yes: args.includes("--yes") });
  } else if (command === "list") {
    const zipPath = args[0];
    if (!zipPath) throw new Error("usage: bun run scripts/backup.ts list <arquivo.zip>");
    await runList(zipPath);
  } else if (argv[0] && !argv[0].startsWith("--")) {
    throw new Error(`unknown command "${argv[0]}" — use no arguments (backup, optionally --camp <id>), "list <zip>" or "restore <zip>".`);
  } else {
    await runBackup(flagValue("--camp"));
  }
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => {});
}
