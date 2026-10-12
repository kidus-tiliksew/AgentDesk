// component-notifications §Settings: pure local-time helpers for quiet hours
// and digest scheduling. Every function takes the instant it works from, so
// results never depend on the host's local zone or clock. Local fields come
// from Intl.DateTimeFormat with an explicit `timeZone` and a 00–23 hour cycle.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// `HH:MM` with hours 00–23 and minutes 00–59.
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// The minute of the day that `HH:MM` names, or null for anything else.
export function parseTime(value: string): number | null {
  const match = HH_MM.exec(value);
  if (match === null) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// True when the runtime's Intl accepts `timeZone`.
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === "") {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

type LocalFields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

// The wall-clock fields of `instant` in `timeZone`.
export function localFields(timeZone: string, instant: number): LocalFields {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") {
      fields[part.type] = Number(part.value);
    }
  }
  return {
    year: fields.year ?? 0,
    month: fields.month ?? 0,
    day: fields.day ?? 0,
    // Some engines print midnight as 24 even with a 00–23 cycle.
    hour: (fields.hour ?? 0) % 24,
    minute: fields.minute ?? 0,
    second: fields.second ?? 0,
  };
}

// The wall-clock fields read as if they were UTC, in epoch milliseconds.
function wallClock(fields: LocalFields): number {
  return Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
}

// The zone's offset from UTC at `instant`, in milliseconds.
function offsetAt(timeZone: string, instant: number): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClock(localFields(timeZone, whole)) - whole;
}

// The local minute of the day (0–1439) at `instant` in `timeZone`.
export function localMinute(timeZone: string, instant: number): number {
  const { hour, minute } = localFields(timeZone, instant);
  return hour * 60 + minute;
}

// True when `instant` falls inside the daily quiet window [start, end) in
// `timeZone`. The start minute is inside and the end minute is outside. A
// window whose end comes before its start runs past midnight
// (req-notification-rules AC-5.3). The test reads only the local wall-clock
// minute, so both occurrences of a repeated local minute get the same answer.
export function inQuietWindow(
  timeZone: string,
  instant: number,
  quietStart: string,
  quietEnd: string,
): boolean {
  const start = parseTime(quietStart);
  const end = parseTime(quietEnd);
  if (start === null || end === null || start === end) {
    return false;
  }
  const minute = localMinute(timeZone, instant);
  return start < end ? start <= minute && minute < end : minute >= start || minute < end;
}

// The canonical instant of local `minuteOfDay` on the local calendar date
// `date` (year, month, day) in `timeZone`. A repeated local time resolves to
// its earlier occurrence. A local time inside a gap moves forward by the
// gap's length, so 02:30 in a one-hour gap becomes 03:30.
function canonicalInstant(
  timeZone: string,
  date: { year: number; month: number; day: number },
  minuteOfDay: number,
): number {
  const target = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  );
  // The true instant lies within 14 hours of `target`, so the offsets a day
  // either side cover every offset in force around it, including both sides of
  // a transition of any length.
  const offsets = new Set([
    offsetAt(timeZone, target - DAY_MS),
    offsetAt(timeZone, target),
    offsetAt(timeZone, target + DAY_MS),
  ]);
  const candidates = [...offsets].map((offset) => target - offset).sort((a, b) => a - b);
  // An existing local time: the candidates that format back to `target`.
  // The earliest one is the first occurrence of a repeated time.
  for (const candidate of candidates) {
    if (wallClock(localFields(timeZone, candidate)) === target) {
      return candidate;
    }
  }
  // A nonexistent local time. Reading it with the offset before the gap gives
  // the instant whose wall clock is `target` plus the gap; it is the earliest
  // candidate that lands after `target`.
  for (const candidate of candidates) {
    if (wallClock(localFields(timeZone, candidate)) > target) {
      return candidate;
    }
  }
  throw new Error(`Cannot resolve local time in ${timeZone}`);
}

// The local calendar date after `date`, by calendar arithmetic rather than by
// adding 24 hours to an instant.
function nextDate(date: { year: number; month: number; day: number }) {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

// The first canonical instant of local `digestTime` in `timeZone` strictly
// after `after` (req-notification-rules REQ-6). Each local date has one
// canonical instant (see canonicalInstant). When the date of `after` has its
// instant at or before `after`, the next local date's instant is used, so a
// repeated digest time never schedules twice on one date.
export function nextDigestAt(timeZone: string, digestTime: string, after: number): number {
  const minuteOfDay = parseTime(digestTime);
  if (minuteOfDay === null) {
    throw new Error(`Invalid digest time ${digestTime}`);
  }
  let date = localFields(timeZone, after);
  // Two steps always suffice; the bound keeps a malformed zone from looping.
  for (let step = 0; step < 3; step += 1) {
    const candidate = canonicalInstant(timeZone, date, minuteOfDay);
    if (candidate > after) {
      return candidate;
    }
    date = { ...date, ...nextDate(date) };
  }
  throw new Error(`Cannot schedule a digest in ${timeZone}`);
}
