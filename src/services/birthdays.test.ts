import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, json, resetData, startTestDb, stopTestDb, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";
import { EMPTY_STAFF, insertStaff } from "../models/staff";
import { insertBedroom } from "../models/bedrooms";
import { insertEvent } from "../models/schedule";
import { DEFAULT_SETTINGS, updateSettings } from "../models/settings";
import { sendBirthdayNotices } from "./notify";
import { todayInSaoPaulo } from "../utils";

/** Decision 51: core answers today's birthday ids; Acampa greets the kid's room team by template, once per kid per day. */
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const CARE = "person-caretaker";
const HELPER = "person-helper";
const OUTSIDER = "person-other-room";
const KID_A = "person-kid-a";
const KID_B = "person-kid-b";
const SLUG = "acampa-birthday";

/** 08:00 in São Paulo (UTC-3) today — after the 07:45 send time */
const now = new Date(`${todayInSaoPaulo()}T11:00:00Z`);
const tomorrow = new Date(now.getTime() + 24 * 3600_000);

beforeAll(async () => {
  await startTestDb();
  keys = await createTestKeys();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await resetData();
  core = createFakeCore();
  world = emptyWorld();
  for (const [id, name] of [[CARE, "Líder Teste"], [HELPER, "Ajuda Teste"], [OUTSIDER, "Outra Pessoa"], [KID_A, "Ana Pequena"], [KID_B, "Bruno Pequeno"]]) world.names.set(id, name);
  world.memberships.push(
    { personId: CARE, role: "equipe", editionId: TEST_EDITION },
    { personId: HELPER, role: "equipe", editionId: TEST_EDITION },
    { personId: OUTSIDER, role: "equipe", editionId: TEST_EDITION },
    { personId: KID_A, role: "participante", editionId: TEST_EDITION },
    { personId: KID_B, role: "participante", editionId: TEST_EDITION },
  );
  world.birthdays.add(KID_A);
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  const room = (await insertBedroom({ name: "101", group: "girls", bunkBeds: 2, singleBeds: 1, notes: "" }))._id;
  const other = (await insertBedroom({ name: "102", group: "boys", bunkBeds: 2, singleBeds: 1, notes: "" }))._id;
  await insertStaff(CARE, { ...EMPTY_STAFF, bedroom: room, roomRole: "caretaker" });
  await insertStaff(HELPER, { ...EMPTY_STAFF, bedroom: room });
  await insertStaff(OUTSIDER, { ...EMPTY_STAFF, bedroom: other });
  await insertCamper(KID_A, { ...EMPTY_CAMPER, bedroom: room });
  await insertCamper(KID_B, { ...EMPTY_CAMPER, bedroom: other });
  await insertEvent({ date: todayInSaoPaulo(), title: "Dia de acampamento", emoji: "🏕️", startTime: "00:00", endTime: "23:59", notes: "", roles: [], visibleToParents: true, assignments: [] });
  await updateSettings({ notifications: { ...DEFAULT_SETTINGS.notifications, birthdays: true } });
});

const sentTo = () => world.messages.filter((m) => m.slug === SLUG).flatMap((m) => m.recipients);

describe("birthday messages (decision 51)", () => {
  test("the kid's room team gets the birthday template by person id — kid's first name and room, nothing else", async () => {
    await sendBirthdayNotices(now);
    expect(sentTo()).toEqual([
      { personId: CARE, variables: { name: "Líder", kid: "Ana", room: "101" } },
      { personId: HELPER, variables: { name: "Ajuda", kid: "Ana", room: "101" } },
    ]);
    const asked = core.callsTo("POST /projects/project-test-1/people/birthdays-today");
    expect(asked).toHaveLength(1);
    expect(asked[0].json).toEqual({ editionId: TEST_EDITION });
    expect(asked[0].headers.get("authorization")).toBe("Bearer system:persons:app-names");
  });

  test("once per kid per day: the hourly safety net never repeats it", async () => {
    await sendBirthdayNotices(now);
    await sendBirthdayNotices(new Date(now.getTime() + 3600_000));
    expect(sentTo()).toHaveLength(2);
  });

  test("the marker only lives on its own day — no trace of when a birthday is, and no birth date stored", async () => {
    await sendBirthdayNotices(now);
    const db = await rawDb();
    expect((await db.collection("participants").findOne({ personId: KID_A }))?.birthdayNoticeDay).toBe(todayInSaoPaulo(now));
    world.birthdays.clear();
    await sendBirthdayNotices(tomorrow);
    expect((await db.collection("participants").findOne({ personId: KID_A }))?.birthdayNoticeDay).toBeUndefined();
    for (const doc of await db.collection("participants").find({}).toArray()) expect(Object.keys(doc)).not.toContain("birthDate");
  });

  test("nothing before 07:45, off the camp days, with the setting off or while the rooms are a draft", async () => {
    await sendBirthdayNotices(new Date(`${todayInSaoPaulo()}T10:30:00Z`)); // 07:30 SP
    await sendBirthdayNotices(tomorrow); // not a camp day
    await updateSettings({ kidsRoomsDraft: true });
    await sendBirthdayNotices(now);
    await updateSettings({ kidsRoomsDraft: false, notifications: { ...DEFAULT_SETTINGS.notifications, birthdays: false } });
    await sendBirthdayNotices(now);
    expect(sentTo()).toHaveLength(0);
    expect(core.callsTo("POST /projects/project-test-1/people/birthdays-today")).toHaveLength(0);
  });

  test("a kid of another project / not in this camp, or one without a room, gets no message", async () => {
    world.birthdays.clear();
    world.birthdays.add("person-not-in-camp");
    await sendBirthdayNotices(now);
    await (await rawDb()).collection("participants").updateOne({ personId: KID_A }, { $set: { bedroom: null } });
    world.birthdays.add(KID_A);
    await sendBirthdayNotices(now);
    expect(sentTo()).toHaveLength(0);
  });

  test("core down or the message refused: no marker, the next run tries again", async () => {
    core.setDown(true);
    await sendBirthdayNotices(now);
    core.setDown(false);
    core.on("POST /projects/project-test-1/messages", () => json({ reason: "unavailable" }, 503));
    await sendBirthdayNotices(now);
    expect((await (await rawDb()).collection("participants").findOne({ personId: KID_A }))?.birthdayNoticeDay).toBeUndefined();
    installFakeCore(core, world);
    await sendBirthdayNotices(now);
    expect(sentTo()).toHaveLength(2);
  });
});
