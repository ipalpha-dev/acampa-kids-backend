import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Collection, Document } from "mongodb";
import { resetData, startTestDb, stopTestDb } from "../testing/ipalphaHarness";
import { createApp } from "../app";
import { rawDb } from "../db";
import { ensureIndex, indexName } from "./indexes";
import { isBooted, markBooted, resetReadiness } from "./readiness";
import { ensureUserCampStateIndexes } from "../models/userCampState";
import { ensureMedicationIndexes } from "../models/medications";
import { ensureCamperIndexes } from "../models/campers";
import { ensureOccurrenceIndexes } from "../models/occurrences";

beforeAll(startTestDb);
afterAll(stopTestDb);

let wasBooted = false;
beforeEach(async () => {
  await resetData();
  wasBooted = isBooted();
});

async function freshCollection(name: string): Promise<Collection<Document>> {
  const db = await rawDb();
  await db.collection(name).drop().catch(() => {});
  return db.collection(name);
}

describe("decision 91 — an index Mongo refuses never blocks boot", () => {
  test("duplicate keys under a unique index: no throw, logged by name + code only, /ready 200 with indexes: degraded", async () => {
    const col = await freshCollection("indexProbe");
    await col.insertMany([{ who: "Maria da Silva" }, { who: "Maria da Silva" }]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      resetReadiness(false);
      expect(await ensureIndex(col, { who: 1 }, { unique: true })).toBe(false);
      const logged = errors.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).toContain("indexProbe.who_1");
      expect(logged).toContain("11000");
      expect(logged).not.toContain("Maria"); // never a document value (Mongo's dup-key message carries keyValue)

      const app = createApp({ bootGate: true });
      markBooted();
      const res = await app.request("/ready");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ready: true, checks: { boot: "ok", mongo: "ok", indexes: "degraded" } });
    } finally {
      errors.mockRestore();
      resetReadiness(wasBooted);
      await col.drop().catch(() => {});
    }
  });

  test("/ready says indexes: ok when every index was created", async () => {
    try {
      resetReadiness(false);
      markBooted();
      const res = await createApp({ bootGate: true }).request("/ready");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ checks: { indexes: "ok" } });
    } finally {
      resetReadiness(wasBooted);
    }
  });

  test("a model's ensure* resolves even when its unique index is refused (boot goes on, no retry loop)", async () => {
    const col = await freshCollection("userCampState");
    await col.insertMany([{ personId: "p-1", campId: "c-1" }, { personId: "p-1", campId: "c-1" }]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await ensureUserCampStateIndexes(); // resolves — never throws on a server-side index error
      expect(errors.mock.calls.length).toBe(1);
      expect(String(errors.mock.calls[0][0])).toContain("personId_campId_unique_v2");
    } finally {
      errors.mockRestore();
      resetReadiness(wasBooted);
      await col.deleteMany({});
      await ensureUserCampStateIndexes();
    }
  });

  test("userCampState unique index is partial on personId: rows without it never break it", async () => {
    const col = await freshCollection("userCampState");
    await col.insertMany([{ userId: "u-1", campId: "c-1" }, { userId: "u-1", campId: "c-1" }]);
    await ensureUserCampStateIndexes();
    const idx = (await col.indexes()).find((i) => i.name === "personId_campId_unique_v2");
    expect(idx).toMatchObject({ unique: true, partialFilterExpression: { personId: { $exists: true } } });
    await col.deleteMany({});
  });

  test("Mongo itself unreachable (a client-side error) is rethrown, so boot waits for Mongo", async () => {
    const down = {
      collectionName: "probe",
      createIndex: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    } as unknown as Collection<Document>;
    await expect(ensureIndex(down, { a: 1 })).rejects.toThrow("ECONNREFUSED");
  });
});

describe("decision 91 — indexes whose keys changed carry new names", () => {
  test("medications, check-in / change logs, occurrences, userCampState", async () => {
    const db = await rawDb();
    await ensureMedicationIndexes();
    await ensureCamperIndexes();
    await ensureOccurrenceIndexes();
    await ensureUserCampStateIndexes();
    const names = async (c: string) => (await db.collection(c).indexes()).map((i) => i.name);
    expect(await names("medicationDoses")).toEqual(expect.arrayContaining(["campId_1_dose_scheduled_unique_v2", "campId_1_personId_day_v2"]));
    expect(await names("medicationDoses")).not.toContain("campId_1_dose_scheduled_unique");
    expect(await names("checkinLog")).toContain("campId_1_personId_at_v2");
    expect(await names("camperChangeLog")).toContain("campId_1_personId_at_v2");
    expect(await names("occurrences")).toEqual(expect.arrayContaining(["campId_1_campers_createdAt_v2", "campId_1_staff_createdAt_v2"]));
    expect(await names("userCampState")).toContain("personId_campId_unique_v2");
  });

  test("indexName mirrors Mongo's naming (scoped collections get the campId prefix)", () => {
    expect(indexName("medicationDoses", { personId: 1 }, { name: "x_v2" })).toBe("campId_1_x_v2");
    expect(indexName("sessions", { expiresAt: 1 })).toBe("expiresAt_1");
    expect(indexName("scores", { createdAt: -1 })).toBe("campId_1_createdAt_-1");
  });
});
