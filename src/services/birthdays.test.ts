import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeCore, createTestKeys, emptyWorld, enableIpalpha, installFakeCore, json, resetData, startTestDb, stopTestDb, TEST_EDITION, type FakeCore, type FakeWorld, type TestKeys } from "../testing/ipalphaHarness";
import { rawDb } from "../db";
import { EMPTY_CAMPER, insertCamper } from "../models/campers";
import { setCampEditionId } from "../models/camps";
import { insertEvent } from "../models/schedule";
import { DEFAULT_SETTINGS, updateSettings } from "../models/settings";
import { activeCampId } from "./campContext";
import { sendBirthdayNotices } from "./notify";
import { todayInSaoPaulo } from "../utils";

/** Decision 51 (Round 2): the team gets a notice as an audience with `birthdayOf: participante`; core fills `{birthdayNames}` per recipient — Acampa never learns who. */
let keys: TestKeys;
let core: FakeCore;
let world: FakeWorld;

const KID_A = "person-kid-a";
const KID_B = "person-kid-b";
const CARE = "person-caretaker";
const ADMIN = "person-admin";
const VESTS = "person-vests";
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
  for (const [id, name] of [[KID_A, "Ana Pequena"], [CARE, "Líder Teste"], [ADMIN, "Coordenadora"], [VESTS, "Coletes Teste"]]) world.names.set(id, name);
  world.memberships.push(
    { personId: ADMIN, role: "coordenacao" },
    { personId: VESTS, role: "coletes", editionId: TEST_EDITION },
    { personId: CARE, role: "equipe", editionId: TEST_EDITION },
    { personId: KID_A, role: "participante", editionId: TEST_EDITION },
    { personId: KID_B, role: "participante", editionId: TEST_EDITION },
  );
  world.birthdays.add(KID_A);
  world.birthdays.add(CARE);
  installFakeCore(core, world);
  enableIpalpha(core, keys);
  await setCampEditionId(activeCampId(), TEST_EDITION);
  await insertCamper(KID_A, { ...EMPTY_CAMPER });
  await insertCamper(KID_B, { ...EMPTY_CAMPER });
  await insertEvent({ date: todayInSaoPaulo(), title: "Dia de acampamento", emoji: "🏕️", startTime: "00:00", endTime: "23:59", notes: "", roles: [], visibleToParents: true, assignments: [] });
  await updateSettings({ notifications: { ...DEFAULT_SETTINGS.notifications, birthdays: true } });
});

const sends = () => core.callsTo("POST /projects/project-test-1/messages").filter((c) => (c.json as { templateSlug: string }).templateSlug === SLUG);

describe("birthday messages (decision 51)", () => {
  test("one audience send to the team roles with birthdayOf: participante — core fills {name} / {birthdayNames}, roles that see no kid are skipped", async () => {
    await sendBirthdayNotices(now);
    const body = sends()[0].json as { templateSlug: string; audience: { roles: string[]; editionId: string; birthdayOf: { roles: string[] } }; variables?: unknown };
    expect(sends()).toHaveLength(1);
    expect(body.audience.birthdayOf).toEqual({ roles: ["participante"] });
    expect(body.audience.editionId).toBe(TEST_EDITION);
    expect(body.audience.roles).toEqual(expect.arrayContaining(["equipe", "coordenacao", "saude", "coletes"]));
    expect(body.variables).toBeUndefined();
    expect(sends()[0].headers.get("authorization")).toBe("Bearer system:notifications:send-template");
    // the fake renders like core: the vests helper's role sees no kid → skipped; CARE's own birthday is not a kid's
    expect(world.messages.find((m) => m.slug === SLUG)?.recipients).toEqual([
      { personId: ADMIN, variables: { name: "Coordenadora", birthdayNames: "Ana" } },
      { personId: CARE, variables: { name: "Líder", birthdayNames: "Ana" } },
    ]);
    expect(core.calls.some((c) => c.path.includes("birthdays-today"))).toBe(false);
  });

  test("outside the team's access window plain equipe is left out; no birthday today → nothing accepted", async () => {
    await updateSettings({ staffAccessWindow: { from: new Date(now.getTime() + 86400_000), until: new Date(now.getTime() + 2 * 86400_000) } } as never);
    world.birthdays.clear();
    await sendBirthdayNotices(now);
    const body = sends()[0].json as { audience: { roles: string[] } };
    expect(body.audience.roles).not.toContain("equipe");
    expect(world.messages.find((m) => m.slug === SLUG)?.recipients).toEqual([]);
  });

  test("once per camp day: the hourly safety net never repeats it", async () => {
    await sendBirthdayNotices(now);
    await sendBirthdayNotices(new Date(now.getTime() + 3600_000));
    expect(sends()).toHaveLength(1);
  });

  test("the marker is the camp day only — no trace of whose birthday it is, and no birth date stored", async () => {
    await sendBirthdayNotices(now);
    const db = await rawDb();
    expect((await db.collection("settings").findOne({ _id: activeCampId() as never }))?.birthdayNoticeDay).toBe(todayInSaoPaulo(now));
    for (const doc of await db.collection("participants").find({}).toArray()) {
      expect(Object.keys(doc)).not.toContain("birthDate");
      expect(Object.keys(doc)).not.toContain("birthdayNoticeDay");
    }
  });

  test("nothing before 07:45, off the camp days or with the setting off", async () => {
    await sendBirthdayNotices(new Date(`${todayInSaoPaulo()}T10:30:00Z`)); // 07:30 SP
    await sendBirthdayNotices(tomorrow); // not a camp day
    await updateSettings({ notifications: { ...DEFAULT_SETTINGS.notifications, birthdays: false } });
    await sendBirthdayNotices(now);
    expect(sends()).toHaveLength(0);
  });

  test("core down or the message refused: the marker is lifted, the next run tries again", async () => {
    core.setDown(true);
    await sendBirthdayNotices(now);
    core.setDown(false);
    core.on("POST /projects/project-test-1/messages", () => json({ reason: "unavailable" }, 503));
    await sendBirthdayNotices(now);
    expect((await (await rawDb()).collection("settings").findOne({ _id: activeCampId() as never }))?.birthdayNoticeDay).toBeUndefined();
    installFakeCore(core, world);
    await sendBirthdayNotices(now);
    expect(world.messages.filter((m) => m.slug === SLUG)).toHaveLength(1);
  });
});
