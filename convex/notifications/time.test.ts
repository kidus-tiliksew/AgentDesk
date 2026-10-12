import { describe, expect, test } from "vitest";
import { inQuietWindow, isValidTimeZone, localMinute, nextDigestAt, parseTime } from "./time";

// These run in the edge runtime that convex-test uses for Convex functions
// (convex/vitest.config.ts), so the Intl zone data is the one `route` and the
// settings mutations see. Every expectation is a fixed UTC instant.

const NY = "America/New_York";
const BERLIN = "Europe/Berlin";
// Lord Howe moves its clocks by 30 minutes, a transition that is not a whole
// hour.
const LORD_HOWE = "Australia/Lord_Howe";

const utc = (iso: string) => Date.parse(iso);

describe("parseTime", () => {
  test.each([
    ["00:00", 0],
    ["09:00", 540],
    ["23:59", 1439],
  ])("reads %s", (value, minute) => {
    expect(parseTime(value)).toBe(minute);
  });

  test.each(["24:00", "9:00", "09:60", "09:00:00", "", " 09:00", "0900", "ab:cd"])(
    "refuses %j",
    (value) => {
      expect(parseTime(value)).toBeNull();
    },
  );
});

describe("isValidTimeZone", () => {
  test.each([NY, BERLIN, LORD_HOWE, "UTC"])("accepts %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  test.each(["Not/AZone", "", "Europe/Atlantis"])("refuses %j", (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});

describe("localMinute", () => {
  test("reads the zone's wall clock, not the host's", () => {
    expect(localMinute(NY, utc("2026-10-12T13:05:00Z"))).toBe(9 * 60 + 5);
    expect(localMinute(BERLIN, utc("2026-10-12T22:30:00Z"))).toBe(30);
    expect(localMinute("UTC", utc("2026-01-01T00:00:00Z"))).toBe(0);
  });
});

// req-notification-rules REQ-5, AC-5.3
describe("inQuietWindow", () => {
  test("a window inside one day includes its start and excludes its end", () => {
    // 2026-10-12 is EDT (UTC-4).
    expect(inQuietWindow(NY, utc("2026-10-12T12:59:00Z"), "09:00", "17:00")).toBe(false);
    expect(inQuietWindow(NY, utc("2026-10-12T13:00:00Z"), "09:00", "17:00")).toBe(true);
    expect(inQuietWindow(NY, utc("2026-10-12T20:59:00Z"), "09:00", "17:00")).toBe(true);
    expect(inQuietWindow(NY, utc("2026-10-12T21:00:00Z"), "09:00", "17:00")).toBe(false);
  });

  test("a window whose end comes before its start runs past midnight", () => {
    // 2026-10-12 is CEST (UTC+2).
    expect(inQuietWindow(BERLIN, utc("2026-10-12T19:59:00Z"), "22:00", "07:00")).toBe(false);
    expect(inQuietWindow(BERLIN, utc("2026-10-12T20:00:00Z"), "22:00", "07:00")).toBe(true);
    expect(inQuietWindow(BERLIN, utc("2026-10-12T22:30:00Z"), "22:00", "07:00")).toBe(true);
    expect(inQuietWindow(BERLIN, utc("2026-10-13T04:59:00Z"), "22:00", "07:00")).toBe(true);
    expect(inQuietWindow(BERLIN, utc("2026-10-13T05:00:00Z"), "22:00", "07:00")).toBe(false);
  });

  test("follows the offset on both sides of a daylight-saving change", () => {
    // New York moves to EDT on 2026-03-08: 11:30Z is 06:30 before, 07:30 after.
    expect(inQuietWindow(NY, utc("2026-03-07T11:30:00Z"), "07:00", "08:00")).toBe(false);
    expect(inQuietWindow(NY, utc("2026-03-09T11:30:00Z"), "07:00", "08:00")).toBe(true);
    // Berlin moves to CEST on 2026-03-29: 07:30Z is 08:30 before, 09:30 after.
    expect(inQuietWindow(BERLIN, utc("2026-03-28T07:30:00Z"), "08:00", "09:00")).toBe(true);
    expect(inQuietWindow(BERLIN, utc("2026-03-30T07:30:00Z"), "08:00", "09:00")).toBe(false);
  });

  test("both occurrences of a repeated local minute get the same answer", () => {
    // 01:30 occurs at 05:30Z (EDT) and 06:30Z (EST) on 2026-11-01.
    expect(inQuietWindow(NY, utc("2026-11-01T05:30:00Z"), "01:00", "02:00")).toBe(true);
    expect(inQuietWindow(NY, utc("2026-11-01T06:30:00Z"), "01:00", "02:00")).toBe(true);
    expect(inQuietWindow(NY, utc("2026-11-01T05:30:00Z"), "02:00", "03:00")).toBe(false);
    expect(inQuietWindow(NY, utc("2026-11-01T06:30:00Z"), "02:00", "03:00")).toBe(false);
  });

  test("an unset, malformed, or empty window is never quiet", () => {
    expect(inQuietWindow(NY, utc("2026-10-12T13:00:00Z"), "09:00", "09:00")).toBe(false);
    expect(inQuietWindow(NY, utc("2026-10-12T13:00:00Z"), "9:00", "17:00")).toBe(false);
  });
});

// req-notification-rules REQ-6, AC-6.1
describe("nextDigestAt", () => {
  test("is the next local digest time, strictly after the given instant", () => {
    expect(nextDigestAt("UTC", "09:00", utc("2026-10-12T08:00:00Z"))).toBe(
      utc("2026-10-12T09:00:00Z"),
    );
    expect(nextDigestAt("UTC", "09:00", utc("2026-10-12T09:00:00Z"))).toBe(
      utc("2026-10-13T09:00:00Z"),
    );
    expect(nextDigestAt("UTC", "09:00", utc("2026-10-12T09:00:00.001Z"))).toBe(
      utc("2026-10-13T09:00:00Z"),
    );
    expect(nextDigestAt(NY, "09:00", utc("2026-10-12T12:00:00Z"))).toBe(
      utc("2026-10-12T13:00:00Z"),
    );
    expect(nextDigestAt(BERLIN, "21:15", utc("2026-10-12T12:00:00Z"))).toBe(
      utc("2026-10-12T19:15:00Z"),
    );
  });

  test("rolls over to the next local date, month, and year", () => {
    expect(nextDigestAt("UTC", "09:00", utc("2026-12-31T10:00:00Z"))).toBe(
      utc("2027-01-01T09:00:00Z"),
    );
    expect(nextDigestAt(NY, "09:00", utc("2026-02-28T15:00:00Z"))).toBe(
      utc("2026-03-01T14:00:00Z"),
    );
    // Kiritimati is UTC+14: 09:30Z on 2026-10-12 is 23:30 local, so the next
    // 09:00 is on local 2026-10-13, which is still 2026-10-12 in UTC.
    expect(nextDigestAt("Pacific/Kiritimati", "09:00", utc("2026-10-12T09:30:00Z"))).toBe(
      utc("2026-10-12T19:00:00Z"),
    );
  });

  test("advances by local date across a transition, not by 24 hours", () => {
    // 10:00 EST on 2026-03-07, then 09:00 EDT on 2026-03-08: 23 hours later.
    expect(nextDigestAt(NY, "09:00", utc("2026-03-07T15:00:00Z"))).toBe(
      utc("2026-03-08T13:00:00Z"),
    );
    // 10:00 EDT on 2026-10-31, then 09:00 EST on 2026-11-01: 24 hours later
    // by the wall clock, 24 + 1 by elapsed time.
    expect(nextDigestAt(NY, "09:00", utc("2026-10-31T14:00:00Z"))).toBe(
      utc("2026-11-01T14:00:00Z"),
    );
    expect(nextDigestAt(BERLIN, "09:00", utc("2026-03-28T09:00:00Z"))).toBe(
      utc("2026-03-29T07:00:00Z"),
    );
  });

  test("moves a nonexistent local time forward by the gap", () => {
    // New York skips 02:00–03:00 on 2026-03-08: 02:30 becomes 03:30 EDT.
    expect(nextDigestAt(NY, "02:30", utc("2026-03-08T05:00:00Z"))).toBe(
      utc("2026-03-08T07:30:00Z"),
    );
    // Berlin skips 02:00–03:00 on 2026-03-29: 02:30 becomes 03:30 CEST.
    expect(nextDigestAt(BERLIN, "02:30", utc("2026-03-28T23:00:00Z"))).toBe(
      utc("2026-03-29T01:30:00Z"),
    );
    // The day after the gap uses the ordinary time again.
    expect(nextDigestAt(NY, "02:30", utc("2026-03-08T07:30:00Z"))).toBe(
      utc("2026-03-09T06:30:00Z"),
    );
  });

  test("uses the earlier occurrence of a repeated local time, once per date", () => {
    // New York repeats 01:00–02:00 on 2026-11-01: 01:30 is 05:30Z, then 06:30Z.
    expect(nextDigestAt(NY, "01:30", utc("2026-11-01T04:00:00Z"))).toBe(
      utc("2026-11-01T05:30:00Z"),
    );
    // At or after the first occurrence, the next digest is on the next date,
    // never the second occurrence on the same date.
    expect(nextDigestAt(NY, "01:30", utc("2026-11-01T05:30:00Z"))).toBe(
      utc("2026-11-02T06:30:00Z"),
    );
    expect(nextDigestAt(NY, "01:30", utc("2026-11-01T06:00:00Z"))).toBe(
      utc("2026-11-02T06:30:00Z"),
    );
    // Berlin repeats 02:00–03:00 on 2026-10-25: 02:30 is 00:30Z, then 01:30Z.
    expect(nextDigestAt(BERLIN, "02:30", utc("2026-10-24T22:00:00Z"))).toBe(
      utc("2026-10-25T00:30:00Z"),
    );
    expect(nextDigestAt(BERLIN, "02:30", utc("2026-10-25T00:45:00Z"))).toBe(
      utc("2026-10-26T01:30:00Z"),
    );
  });

  test("handles a 30-minute transition", () => {
    // Lord Howe skips 02:00–02:30 on 2026-10-04 (UTC+10:30 to UTC+11):
    // 02:15 becomes 02:45 at UTC+11.
    expect(nextDigestAt(LORD_HOWE, "02:15", utc("2026-10-03T13:30:00Z"))).toBe(
      utc("2026-10-03T15:45:00Z"),
    );
    // Lord Howe repeats 01:30–02:00 on 2026-04-05 (UTC+11 to UTC+10:30):
    // 01:45 is 14:45Z at UTC+11, then 15:15Z at UTC+10:30.
    expect(nextDigestAt(LORD_HOWE, "01:45", utc("2026-04-04T13:00:00Z"))).toBe(
      utc("2026-04-04T14:45:00Z"),
    );
    expect(nextDigestAt(LORD_HOWE, "01:45", utc("2026-04-04T14:45:00Z"))).toBe(
      utc("2026-04-05T15:15:00Z"),
    );
  });

  test("refuses a malformed digest time", () => {
    expect(() => nextDigestAt("UTC", "9:00", 0)).toThrow();
  });
});
