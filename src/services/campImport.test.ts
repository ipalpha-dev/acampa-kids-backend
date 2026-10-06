import { describe, expect, test } from "bun:test";
import { normalizeKey, remapLink, settingsToImport, stripForCopy, type SettingsRemap } from "./campImport";
import { DEFAULT_SETTINGS } from "../models/settings";
import type { Settings } from "../types";

describe("normalizeKey", () => {
  test("is accent and case insensitive", () => {
    expect(normalizeKey("Ana Lúcia")).toBe(normalizeKey("ana lucia"));
    expect(normalizeKey("JOÃO")).toBe(normalizeKey("joão"));
  });
});

describe("remapLink", () => {
  test("prefers the idMap over the soft match", () => {
    const idMap = new Map([["old1", "fromMap"]]);
    const soft = new Map([["old1", "fromSoft"]]);
    expect(remapLink("old1", idMap, soft)).toBe("fromMap");
  });
  test("falls back to the soft match when the idMap misses", () => {
    const idMap = new Map<string, string>();
    const soft = new Map([["old1", "fromSoft"]]);
    expect(remapLink("old1", idMap, soft)).toBe("fromSoft");
  });
  test("null when neither has it, or the input is null", () => {
    expect(remapLink("old1", new Map(), new Map())).toBeNull();
    expect(remapLink(null, new Map(), new Map())).toBeNull();
  });
});

describe("stripForCopy", () => {
  test("never leaks _id, campId, importId or aiReview* fields", () => {
    const doc = {
      _id: "abc",
      campId: "camp1",
      createdAt: new Date(),
      updatedAt: new Date(),
      importId: "import-1",
      aiReviewStatus: "reviewed",
      aiReviewError: "",
      name: "Ana",
    };
    const out = stripForCopy(doc);
    expect(out).not.toHaveProperty("_id");
    expect(out).not.toHaveProperty("campId");
    expect(out).not.toHaveProperty("importId");
    expect(out).not.toHaveProperty("aiReviewStatus");
    expect(out).not.toHaveProperty("aiReviewError");
    expect(out.name).toBe("Ana");
  });
  test("never leaks check-in fields when they are named in extraStrip", () => {
    const doc = { checkin: { at: new Date() }, busCheckin: null, vest: { delivered: null, returned: null }, name: "Ana" };
    const out = stripForCopy(doc, ["checkin", "busCheckin", "vest"]);
    expect(out).not.toHaveProperty("checkin");
    expect(out).not.toHaveProperty("busCheckin");
    expect(out).not.toHaveProperty("vest");
    expect(out.name).toBe("Ana");
  });
});

describe("settingsToImport", () => {
  const remap: SettingsRemap = {
    person: (id) => (id === "known" ? "known" : null),
    vehicle: (id) => (id === "vehicle-known" ? "vehicle-new" : null),
  };

  test("drops bus helpers whose person is not on the team or whose vehicle didn't remap", () => {
    const source: Settings = { ...DEFAULT_SETTINGS, busHelpers: { helpers: [{ personId: "known", vehicleId: "vehicle-known" }, { personId: "known", vehicleId: "unknown" }, { personId: "unknown", vehicleId: "vehicle-known" }] } };
    expect(settingsToImport(source, remap).busHelpers).toEqual({ helpers: [{ personId: "known", vehicleId: "vehicle-new" }] });
  });
  test("drops parent contacts whose person is not on the team", () => {
    const source: Settings = { ...DEFAULT_SETTINGS, parentContacts: [{ id: "c1", title: "Coordenação", personId: "known" }, { id: "c2", title: "Outro", personId: "unknown" }] };
    expect(settingsToImport(source, remap).parentContacts).toEqual([{ id: "c1", title: "Coordenação", personId: "known" }]);
  });
  test("never copies windows, drafts, wizardMode or galleryPublished", () => {
    const source: Settings = { ...DEFAULT_SETTINGS, wizardMode: true, galleryPublished: true, kidsRoomsDraft: true, scoreDraft: true };
    const out = settingsToImport(source, remap);
    for (const key of ["wizardMode", "galleryPublished", "kidsRoomsDraft", "scoreDraft", "checkinWindow", "busReturnWindow", "staffAccessWindow", "parentAccessWindow", "scoreHideWindow", "checkinReminder"]) expect(out).not.toHaveProperty(key);
  });
  test("keeps checkinLocations and notifications verbatim", () => {
    const out = settingsToImport(DEFAULT_SETTINGS, remap);
    expect(out.checkinLocations).toEqual(DEFAULT_SETTINGS.checkinLocations);
    expect(out.notifications).toEqual(DEFAULT_SETTINGS.notifications);
  });
});
