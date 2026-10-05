import { describe, expect, test } from "bun:test";
import { BACKUP_COLLECTIONS, backupCollectionNames, restorableCollections, stripBackupDoc } from "./backupScope";
import { SCOPED } from "./campScope";

/** decision 90: the backup is an ALLOWLIST of this version's collections — old Acampa data is never exported nor restored. */
const LEGACY = ["campers", "staff", "users", "camperImports", "camperImportDictionary", "healthQueue", "worker"];
const NEVER = ["sessions", "ipalphaLoginStates", "importJobs", "dispatchDeliveries"];

describe("backup allowlist", () => {
  test("legacy collections, sessions, sign-ins in flight, import jobs and webhook ids are never dumped", () => {
    for (const name of [...LEGACY, ...NEVER]) expect(BACKUP_COLLECTIONS).not.toContain(name);
    const existing = ["participants", "settings", ...LEGACY, ...NEVER, "somethingNew"];
    expect(backupCollectionNames(existing)).toEqual(["participants", "settings"]);
  });

  test("every per-camp collection of this version is backed up", () => {
    for (const name of SCOPED) expect(BACKUP_COLLECTIONS).toContain(name);
  });

  test("a restore writes only allowlisted collections and reports the rest", () => {
    const { keep, skipped } = restorableCollections({ participants: [{ personId: "p" }], campers: [{ name: "x" }], users: [] });
    expect(keep.map(([name]) => name)).toEqual(["participants"]);
    expect(skipped.sort()).toEqual(["campers", "users"]);
  });

  test("the camp-delete code hash never leaves the database", () => {
    expect(stripBackupDoc("camps", { label: "Acampa", deleteOtp: { codeHash: "h" } })).toEqual({ label: "Acampa" });
  });
});
