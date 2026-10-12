import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { notifications } from "./refs";
import { ensureSettings } from "./settings";
import { type Setup, setup } from "./test.setup";

// 2026-10-12 12:00Z: 08:00 EDT in New York, 14:00 CEST in Berlin.
const START = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const unauthenticated = { data: { code: "unauthenticated" } };
const invalid = (field: string) => ({ data: { code: "invalid", field } });

const DEFAULTS = {
  time_zone: "UTC",
  time_zone_source: "default",
  quiet_start: null,
  quiet_end: null,
  urgent_override: true,
  digest_time: "09:00",
  stale_threshold_minutes: 30,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

function settingsOf(t: Setup["t"]) {
  return t.run((ctx) => ctx.db.query("settings").collect());
}

async function rowOf(t: Setup["t"], userId: Id<"users">) {
  const rows = (await settingsOf(t)).filter((row) => row.userId === userId);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("getSettings", () => {
  // req-notification-rules AC-5.2, AC-6.1; req-agent-status AC-3.1
  test("returns the defaults without a row and writes none", async () => {
    const { t, asA } = await setup();
    expect(await asA.query(notifications.settings.getSettings, {})).toEqual(DEFAULTS);
    expect(await settingsOf(t)).toEqual([]);
  });

  test("returns only the person's own settings", async () => {
    const { asA, asB } = await setup();
    await asB.mutation(notifications.settings.updateSettings, {
      timeZone: "Europe/Berlin",
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    expect(await asA.query(notifications.settings.getSettings, {})).toEqual(DEFAULTS);
  });

  test("is unauthenticated without a signed-in person or with an unknown one", async () => {
    const { t } = await setup();
    await expect(t.query(notifications.settings.getSettings, {})).rejects.toMatchObject(
      unauthenticated,
    );
    await expect(
      t.withIdentity({ subject: "user_unknown" }).query(notifications.settings.getSettings, {}),
    ).rejects.toMatchObject(unauthenticated);
  });
});

describe("updateSettings", () => {
  // req-mobile-app REQ-5
  test("stores the supplied fields and returns the effective settings", async () => {
    const { t, userA, asA } = await setup();
    const result = await asA.mutation(notifications.settings.updateSettings, {
      timeZone: "America/New_York",
      quietStart: "22:00",
      quietEnd: "07:00",
      urgentOverride: false,
      digestTime: "18:30",
      staleThresholdMinutes: 45,
    });

    const expected = {
      time_zone: "America/New_York",
      time_zone_source: "user",
      quiet_start: "22:00",
      quiet_end: "07:00",
      urgent_override: false,
      digest_time: "18:30",
      stale_threshold_minutes: 45,
    };
    expect(result).toEqual(expected);
    expect(await asA.query(notifications.settings.getSettings, {})).toEqual(expected);
    // 18:30 EDT on 2026-10-12.
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 12, 22, 30));
  });

  test("keeps omitted fields and clears both quiet endpoints with null", async () => {
    const { asA } = await setup();
    await asA.mutation(notifications.settings.updateSettings, {
      quietStart: "22:00",
      quietEnd: "07:00",
      staleThresholdMinutes: 60,
    });
    await asA.mutation(notifications.settings.updateSettings, { urgentOverride: false });
    expect(await asA.query(notifications.settings.getSettings, {})).toMatchObject({
      quiet_start: "22:00",
      quiet_end: "07:00",
      urgent_override: false,
      stale_threshold_minutes: 60,
    });

    await asA.mutation(notifications.settings.updateSettings, {
      quietStart: null,
      quietEnd: null,
    });
    expect(await asA.query(notifications.settings.getSettings, {})).toEqual({
      ...DEFAULTS,
      urgent_override: false,
      stale_threshold_minutes: 60,
    });
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["an unknown time zone", { timeZone: "Europe/Atlantis" }, "timeZone"],
    ["an empty time zone", { timeZone: "" }, "timeZone"],
    ["a quiet start that is not HH:MM", { quietStart: "9:00", quietEnd: "17:00" }, "quietStart"],
    ["a quiet end out of range", { quietStart: "09:00", quietEnd: "24:00" }, "quietEnd"],
    ["only a quiet start", { quietStart: "22:00" }, "quietEnd"],
    ["only a quiet end", { quietEnd: "07:00" }, "quietStart"],
    ["equal quiet endpoints", { quietStart: "22:00", quietEnd: "22:00" }, "quietEnd"],
    ["a digest time with seconds", { digestTime: "09:00:00" }, "digestTime"],
    ["a digest minute out of range", { digestTime: "09:60" }, "digestTime"],
    ["a fractional threshold", { staleThresholdMinutes: 30.5 }, "staleThresholdMinutes"],
    ["a threshold below 5", { staleThresholdMinutes: 4 }, "staleThresholdMinutes"],
    ["a threshold above 240", { staleThresholdMinutes: 241 }, "staleThresholdMinutes"],
  ])("refuses %s as invalid and writes nothing", async (_name, args, field) => {
    const { t, asA } = await setup();
    await expect(asA.mutation(notifications.settings.updateSettings, args)).rejects.toMatchObject(
      invalid(field),
    );
    expect(await settingsOf(t)).toEqual([]);
  });

  test("a refused update leaves an existing row unchanged", async () => {
    const { t, userA, asA } = await setup();
    await asA.mutation(notifications.settings.updateSettings, {
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    const before = await rowOf(t, userA);

    // Clearing one endpoint would leave a single-ended window.
    await expect(
      asA.mutation(notifications.settings.updateSettings, {
        quietEnd: null,
        staleThresholdMinutes: 60,
      }),
    ).rejects.toMatchObject(invalid("quietEnd"));
    await expect(
      asA.mutation(notifications.settings.updateSettings, {
        digestTime: "07:00",
        timeZone: "Nowhere/Here",
      }),
    ).rejects.toMatchObject(invalid("timeZone"));

    expect(await rowOf(t, userA)).toEqual(before);
  });

  test("accepts the threshold bounds 5 and 240", async () => {
    const { asA } = await setup();
    for (const minutes of [5, 240]) {
      const result = await asA.mutation(notifications.settings.updateSettings, {
        staleThresholdMinutes: minutes,
      });
      expect(result.stale_threshold_minutes).toBe(minutes);
    }
  });

  test("keeps one row per person across repeated and concurrent writers", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await asA.mutation(notifications.settings.updateSettings, { digestTime: "08:00" });
    await asA.mutation(notifications.settings.updateSettings, { digestTime: "08:15" });
    await Promise.all([
      asA.mutation(notifications.settings.updateSettings, { urgentOverride: false }),
      asA.mutation(notifications.settings.initializeTimeZone, { timeZone: "Europe/Berlin" }),
      t.run((ctx) => ensureSettings(ctx, userA, Date.now())),
      asB.mutation(notifications.settings.initializeTimeZone, { timeZone: "America/New_York" }),
      asB.mutation(notifications.settings.updateSettings, { staleThresholdMinutes: 10 }),
      t.run((ctx) => ensureSettings(ctx, userB, Date.now())),
    ]);

    const rows = await settingsOf(t);
    expect(rows.map((row) => row.userId).sort()).toEqual([userA, userB].sort());
  });

  test("changes only the caller's row", async () => {
    const { t, userA, userB, asA, asB } = await setup();
    await asA.mutation(notifications.settings.updateSettings, { staleThresholdMinutes: 15 });
    const before = await rowOf(t, userA);

    await asB.mutation(notifications.settings.updateSettings, {
      timeZone: "Europe/Berlin",
      staleThresholdMinutes: 90,
    });

    expect(await rowOf(t, userA)).toEqual(before);
    expect((await rowOf(t, userB))?.staleThresholdMinutes).toBe(90);
  });

  test("is unauthenticated without a signed-in person or with an unknown one", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(notifications.settings.updateSettings, { urgentOverride: false }),
    ).rejects.toMatchObject(unauthenticated);
    await expect(
      t
        .withIdentity({ subject: "user_unknown" })
        .mutation(notifications.settings.updateSettings, { urgentOverride: false }),
    ).rejects.toMatchObject(unauthenticated);
    expect(await settingsOf(t)).toEqual([]);
  });
});

// req-notification-rules REQ-6, AC-6.1
describe("nextDigestAt", () => {
  test("defaults to the next 09:00 UTC", async () => {
    const { t, userA, asA } = await setup();
    await asA.mutation(notifications.settings.updateSettings, { urgentOverride: false });
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 13, 9, 0));
  });

  test("is recomputed from now when the digest time changes", async () => {
    const { t, userA, asA } = await setup();
    await asA.mutation(notifications.settings.updateSettings, { digestTime: "13:00" });
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 12, 13, 0));

    vi.setSystemTime(START + 2 * HOUR);
    await asA.mutation(notifications.settings.updateSettings, { digestTime: "12:00" });
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 13, 12, 0));
  });

  test("is recomputed when the time zone changes", async () => {
    const { t, userA, asA } = await setup();
    await asA.mutation(notifications.settings.updateSettings, { urgentOverride: false });
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 13, 9, 0));

    // It is 08:00 EDT, so the next digest is 09:00 EDT today.
    await asA.mutation(notifications.settings.updateSettings, { timeZone: "America/New_York" });
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 12, 13, 0));

    // A device zone does not replace the choice, so the schedule stays.
    await asA.mutation(notifications.settings.initializeTimeZone, { timeZone: "Europe/Berlin" });
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 12, 13, 0));
    // It is 14:00 CEST, so the next digest is 09:00 CEST tomorrow.
    await asA.mutation(notifications.settings.updateSettings, { timeZone: "Europe/Berlin" });
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 13, 7, 0));
  });

  test("keeps the schedule on other edits, even when it is overdue", async () => {
    const { t, userA, asA } = await setup();
    await asA.mutation(notifications.settings.updateSettings, { digestTime: "13:00" });
    const scheduled = Date.UTC(2026, 9, 12, 13, 0);

    vi.setSystemTime(scheduled + HOUR);
    await asA.mutation(notifications.settings.updateSettings, {
      quietStart: "22:00",
      quietEnd: "07:00",
      urgentOverride: false,
      staleThresholdMinutes: 60,
    });
    // An unchanged zone and digest time leave the schedule alone, though the
    // zone becomes the person's choice.
    await asA.mutation(notifications.settings.updateSettings, {
      timeZone: "UTC",
      digestTime: "13:00",
    });

    const row = await rowOf(t, userA);
    expect(row?.nextDigestAt).toBe(scheduled);
    expect(row?.timeZoneSource).toBe("user");
  });

  test("moves a digest time inside a daylight-saving gap forward on that day", async () => {
    const { t, userA, asA } = await setup();
    // 00:00 EST on 2026-03-08; New York skips 02:00–03:00 that night.
    vi.setSystemTime(Date.UTC(2026, 2, 8, 5, 0));
    await asA.mutation(notifications.settings.updateSettings, {
      timeZone: "America/New_York",
      digestTime: "02:30",
    });
    // 03:30 EDT.
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  test("uses the first occurrence of a repeated digest time", async () => {
    const { t, userA, asA } = await setup();
    // 00:00 CEST on 2026-10-25; Berlin repeats 02:00–03:00 that night.
    vi.setSystemTime(Date.UTC(2026, 9, 24, 22, 0));
    await asA.mutation(notifications.settings.updateSettings, {
      timeZone: "Europe/Berlin",
      digestTime: "02:30",
    });
    // 02:30 CEST, not 02:30 CET an hour later.
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });
});

// component-notifications §Tables: the `timeZoneSource` rule.
describe("initializeTimeZone", () => {
  test("sets the device zone once while nobody has chosen one", async () => {
    const { t, userA, asA } = await setup();
    const first = await asA.mutation(notifications.settings.initializeTimeZone, {
      timeZone: "America/New_York",
    });
    expect(first).toEqual({
      ...DEFAULTS,
      time_zone: "America/New_York",
      time_zone_source: "device",
    });
    // It is 08:00 EDT, so the next digest is 09:00 EDT today.
    expect((await rowOf(t, userA))?.nextDigestAt).toBe(Date.UTC(2026, 9, 12, 13, 0));

    const again = await asA.mutation(notifications.settings.initializeTimeZone, {
      timeZone: "Europe/Berlin",
    });
    expect(again.time_zone).toBe("America/New_York");
    expect(again.time_zone_source).toBe("device");
  });

  test("works after routing created a default row", async () => {
    const { t, userA, asA } = await setup();
    await t.run((ctx) => ensureSettings(ctx, userA, Date.now()));
    expect((await rowOf(t, userA))?.timeZoneSource).toBe("default");

    const result = await asA.mutation(notifications.settings.initializeTimeZone, {
      timeZone: "Europe/Berlin",
    });
    expect(result.time_zone).toBe("Europe/Berlin");
    expect(result.time_zone_source).toBe("device");
  });

  test("never replaces an explicit choice, including UTC", async () => {
    const { asA } = await setup();
    await asA.mutation(notifications.settings.updateSettings, { timeZone: "UTC" });
    const result = await asA.mutation(notifications.settings.initializeTimeZone, {
      timeZone: "America/New_York",
    });
    expect(result.time_zone).toBe("UTC");
    expect(result.time_zone_source).toBe("user");
  });

  test("a later explicit choice replaces a device zone", async () => {
    const { asA } = await setup();
    await asA.mutation(notifications.settings.initializeTimeZone, { timeZone: "Europe/Berlin" });
    const result = await asA.mutation(notifications.settings.updateSettings, {
      timeZone: "Europe/Berlin",
    });
    expect(result.time_zone_source).toBe("user");
  });

  test("refuses an unknown zone as invalid and writes nothing", async () => {
    const { t, asA } = await setup();
    await expect(
      asA.mutation(notifications.settings.initializeTimeZone, { timeZone: "Mars/Olympus" }),
    ).rejects.toMatchObject(invalid("timeZone"));
    expect(await settingsOf(t)).toEqual([]);
  });

  test("is unauthenticated without a signed-in person", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(notifications.settings.initializeTimeZone, { timeZone: "UTC" }),
    ).rejects.toMatchObject(unauthenticated);
    expect(await settingsOf(t)).toEqual([]);
  });
});

describe("ensureSettings", () => {
  test("inserts the defaults with a next digest once and then returns the row", async () => {
    const { t, userA } = await setup();
    const created = await t.run((ctx) => ensureSettings(ctx, userA, START));
    expect(created).toMatchObject({
      userId: userA,
      timeZone: "UTC",
      timeZoneSource: "default",
      urgentOverride: true,
      digestTime: "09:00",
      staleThresholdMinutes: 30,
      nextDigestAt: Date.UTC(2026, 9, 13, 9, 0),
    });
    expect(created.quietStart).toBeUndefined();
    expect(created.quietEnd).toBeUndefined();

    // A later call, even past the schedule, keeps the row and its schedule.
    const again = await t.run((ctx) => ensureSettings(ctx, userA, START + 3 * DAY));
    expect(again).toEqual(created);
    expect(await settingsOf(t)).toHaveLength(1);
  });
});
