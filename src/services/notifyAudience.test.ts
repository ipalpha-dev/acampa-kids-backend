import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, json, resetData, startTestDb, stopTestDb, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { setCampEditionId } from "../models/camps";
import { EMPTY_STAFF, insertStaff } from "../models/staff";
import { DEFAULT_SETTINGS, updateSettings } from "../models/settings";
import { activeCampId } from "./campContext";
import { flushNotifications, notifyOccurrence, notifyParentEdit, sendCheckinReminder, syncParentWelcomes, welcomeLateFamilies } from "./notify";
import type { Camper, Occurrence } from "../types";

/** Round 2: role audiences leave out who must not get them (`excludePersonIds`); families joining late are welcomed by id. */
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const ADMIN = "person-admin";
const OTHER_ADMIN = "person-admin-2";
const VESTS = "person-vests";
const MEDIC = "person-medic";
const PARENT = "person-parent";
const LATE = "person-late-family";
const closed = { from: new Date(Date.now() + 86400_000), until: new Date(Date.now() + 2 * 86400_000) };

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  for (const [id, name] of [[ADMIN, "Coordenadora"], [OTHER_ADMIN, "Outra Coordenadora"], [VESTS, "Coletes"], [MEDIC, "Saúde"], [PARENT, "Família"], [LATE, "Nova Família"]]) world.names.set(id, name);
  world.memberships.push(
    { personId: ADMIN, role: "coordenacao" },
    { personId: OTHER_ADMIN, role: "coordenacao" },
    { personId: VESTS, role: "coletes", editionId: TEST_EDITION },
    { personId: MEDIC, role: "saude", editionId: TEST_EDITION },
    { personId: PARENT, role: "responsavel", editionId: TEST_EDITION },
  );
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  await setCampEditionId(activeCampId(), TEST_EDITION);
});

const audienceOf = (slug: string) => world.messages.filter((m) => m.slug === slug && m.audience);

describe("role audiences with excludePersonIds", () => {
  test("check-in reminder outside the team window: helpers already checked in are excluded", async () => {
    const at = new Date(Date.now() - 60_000);
    await updateSettings({ staffAccessWindow: closed, checkinReminder: { at, sentAt: null }, notifications: { ...DEFAULT_SETTINGS.notifications, checkinReminder: true } } as never);
    await insertStaff(VESTS, { ...EMPTY_STAFF });
    await insertStaff(MEDIC, { ...EMPTY_STAFF });
    await (await rawDb()).collection("participants").updateOne({ personId: VESTS }, { $set: { checkin: { at: new Date(), byPersonId: VESTS, byRole: "coletes" } } });
    await sendCheckinReminder(new Date());
    const [sent] = audienceOf("acampa-checkin-reminder");
    expect(sent.audience?.excludePersonIds).toContain(VESTS);
    expect(sent.recipients.map((r) => r.personId)).toEqual([MEDIC]);
    expect(sent.recipients[0].variables).toMatchObject({ name: "Saúde" });
  });

  test("a new occurrence reaches every coordenação member but its author", async () => {
    await updateSettings({ notifications: { ...DEFAULT_SETTINGS.notifications, occurrences: true } });
    await notifyOccurrence({ createdByPersonId: ADMIN } as Occurrence);
    const [sent] = audienceOf("acampa-occurrence");
    expect(sent.audience).toMatchObject({ roles: ["coordenacao"], excludePersonIds: [ADMIN] });
    expect(sent.recipients.map((r) => r.personId)).toEqual([OTHER_ADMIN]);
  });
});

describe("families' welcome", () => {
  test("one audience send for the edition, then families who join later get it by id — once", async () => {
    await updateSettings({ notifications: { ...DEFAULT_SETTINGS.notifications, parentWelcome: true } });
    await welcomeLateFamilies([LATE]);
    expect(world.messages).toHaveLength(0); // the edition's welcome has not gone out: they will be part of it
    await syncParentWelcomes();
    expect(audienceOf("acampa-parent-welcome")[0].recipients.map((r) => r.personId)).toEqual([PARENT]);
    world.memberships.push({ personId: LATE, role: "responsavel", editionId: TEST_EDITION });
    await welcomeLateFamilies([LATE]);
    await welcomeLateFamilies([LATE]);
    const byId = world.messages.filter((m) => m.slug === "acampa-parent-welcome" && !m.audience);
    expect(byId.map((m) => m.recipients.map((r) => r.personId))).toEqual([[LATE]]);
    const sentBody = core.callsTo("POST /projects/project-test-1/messages").find((c) => (c.json as { recipients?: unknown }).recipients)?.json as { recipients: { variables: Record<string, string> }[] };
    expect(Object.keys(sentBody.recipients[0].variables)).toEqual(["link"]);
  });
});

describe("no repeats", () => {
  test("the families' welcome is marked sent when the SMS went out, even if its e-mail twin failed", async () => {
    await updateSettings({ notifications: { ...DEFAULT_SETTINGS.notifications, parentWelcome: true } });
    core.on("POST /projects/project-test-1/messages", (c) => {
      if ((c.json as { templateSlug: string }).templateSlug.endsWith("-email")) return json({ reason: "unavailable" }, 503);
      return json({ accepted: 1 });
    });
    await syncParentWelcomes();
    await syncParentWelcomes();
    const sms = core.callsTo("POST /projects/project-test-1/messages").filter((c) => (c.json as { templateSlug: string }).templateSlug === "acampa-parent-welcome");
    expect(sms).toHaveLength(1);
  });

  test("repeated health saves about one kid collapse into one audience send (the last)", async () => {
    await updateSettings({ notifications: { ...DEFAULT_SETTINGS.notifications, parentEdits: true } });
    const kid = { _id: "person-kid", caretakerId: null } as unknown as Camper;
    await notifyParentEdit(kid, { medical: true, byPersonId: PARENT });
    await notifyParentEdit(kid, { medical: true, byPersonId: PARENT });
    expect(audienceOf("acampa-parent-edit-medical")).toHaveLength(0);
    await flushNotifications();
    expect(core.callsTo("POST /projects/project-test-1/messages").filter((c) => (c.json as { templateSlug: string }).templateSlug === "acampa-parent-edit-medical")).toHaveLength(1);
  });
});
