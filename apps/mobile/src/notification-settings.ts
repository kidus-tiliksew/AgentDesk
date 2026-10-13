import type { NotificationSettings } from "../../../convex/notifications/settings";

// component-mobile-app §Screens, notification settings: the form's draft, its
// checks, the `updateSettings` arguments, and the time zone choices
// (req-mobile-app REQ-5). The checks mirror component-notifications
// §Settings so a mistake shows before a call; the backend still checks every
// field and its refusal wins.

export type SettingsField =
  | "timeZone"
  | "quietStart"
  | "quietEnd"
  | "digestTime"
  | "staleThresholdMinutes";

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  "timeZone",
  "quietStart",
  "quietEnd",
  "digestTime",
  "staleThresholdMinutes",
];

export type FieldErrors = Partial<Record<SettingsField, string>>;

// The form's state. Times and the threshold stay text, so a malformed entry
// is kept as typed until it is fixed. `timeZoneChosen` is set when the person
// picks a zone, because `updateSettings` records any supplied zone as the
// person's own choice (`timeZoneSource` `user`).
export type Draft = {
  timeZone: string;
  timeZoneChosen: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  urgentOverride: boolean;
  digestTime: string;
  staleThreshold: string;
};

// `notifications/settings:updateSettings` arguments. `null` clears a quiet
// endpoint. `timeZone` is sent only when the person chose a zone.
export type UpdateArgs = {
  timeZone?: string;
  quietStart: string | null;
  quietEnd: string | null;
  urgentOverride: boolean;
  digestTime: string;
  staleThresholdMinutes: number;
};

export const MIN_STALE_THRESHOLD = 5;
export const MAX_STALE_THRESHOLD = 240;

export const TIME_RULE = "Enter a 24-hour time as HH:MM, from 00:00 to 23:59.";
export const THRESHOLD_RULE = "Enter a whole number of minutes from 5 to 240.";
export const ZONE_RULE = "Choose a valid time zone.";
export const MISSING_START = "Enter a start time for quiet hours.";
export const MISSING_END = "Enter an end time for quiet hours.";
export const EQUAL_TIMES = "Quiet hours must start and end at different times.";

// The zones offered when the runtime's Intl cannot list its own. Any other
// zone stays selectable through the custom zone field.
export const FALLBACK_TIME_ZONES: readonly string[] = [
  "UTC",
  "Africa/Addis_Ababa",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Africa/Nairobi",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Sao_Paulo",
  "America/Toronto",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Paris",
  "Pacific/Auckland",
];

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WHOLE_NUMBER = /^\d+$/;

// The minute of the day that `HH:MM` names, or null for anything else.
export function parseTime(value: string): number | null {
  const match = HH_MM.exec(value);
  if (match === null) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// The window quiet hours start with when the person turns them on and no
// window is saved, so the From and To pickers always hold a time.
export const DEFAULT_QUIET_START = "22:00";
export const DEFAULT_QUIET_END = "07:00";

// The native time pickers work on a Date; the form keeps `HH:MM`. The Date
// is the wall-clock time on 1 January 2000 in the device's zone, a day with
// no daylight-saving change, so every minute of it exists. `fallback` stands
// in for a value that is not a time.
export function timeAsDate(value: string, fallback: string): Date {
  const minutes = parseTime(value) ?? parseTime(fallback) ?? 0;
  return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
}

export function dateAsTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// A zone's short name for the settings row: its city with spaces, such as
// "Addis Ababa" for Africa/Addis_Ababa, or the whole name when it has no
// region, such as UTC.
export function zoneName(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

// True when this runtime's Intl accepts `timeZone`. The backend runs the same
// check in its own runtime, and its answer is the one that counts.
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

// The device's IANA zone, or null when the runtime does not report a valid
// one.
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

// Every zone the runtime lists, or the fallback list when it lists none.
// UTC is always offered.
export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = [];
  try {
    if (typeof intl.supportedValuesOf === "function") {
      zones = intl.supportedValuesOf("timeZone");
    }
  } catch {
    zones = [];
  }
  if (!Array.isArray(zones) || zones.length === 0) {
    return [...FALLBACK_TIME_ZONES];
  }
  return zones.includes("UTC") ? [...zones] : ["UTC", ...zones];
}

// The picker's zones: the device zone first, then the selected zone, then the
// listed zones, each once.
export function zoneChoices(options: {
  selected: string;
  device: string | null;
  supported: readonly string[];
}): string[] {
  const choices: string[] = [];
  const add = (zone: string | null) => {
    if (zone !== null && zone !== "" && !choices.includes(zone)) {
      choices.push(zone);
    }
  };
  add(options.device);
  add(options.selected);
  for (const zone of options.supported) {
    add(zone);
  }
  return choices;
}

// The choices whose name contains `search`, ignoring case and treating a
// space as the underscore IANA names use.
export function filterZones(choices: readonly string[], search: string): string[] {
  const needle = search.trim().toLowerCase().replace(/\s+/g, "_");
  if (needle === "") {
    return [...choices];
  }
  return choices.filter((zone) => zone.toLowerCase().includes(needle));
}

export function draftOf(settings: NotificationSettings): Draft {
  const quietEnabled = settings.quiet_start !== null && settings.quiet_end !== null;
  return {
    timeZone: settings.time_zone,
    timeZoneChosen: false,
    quietEnabled,
    quietStart: settings.quiet_start ?? "",
    quietEnd: settings.quiet_end ?? "",
    urgentOverride: settings.urgent_override,
    digestTime: settings.digest_time,
    staleThreshold: String(settings.stale_threshold_minutes),
  };
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.timeZone === b.timeZone &&
    a.timeZoneChosen === b.timeZoneChosen &&
    a.quietEnabled === b.quietEnabled &&
    a.quietStart === b.quietStart &&
    a.quietEnd === b.quietEnd &&
    a.urgentOverride === b.urgentOverride &&
    a.digestTime === b.digestTime &&
    a.staleThreshold === b.staleThreshold
  );
}

export function sameSettings(a: NotificationSettings, b: NotificationSettings): boolean {
  return (
    a.time_zone === b.time_zone &&
    a.time_zone_source === b.time_zone_source &&
    a.quiet_start === b.quiet_start &&
    a.quiet_end === b.quiet_end &&
    a.urgent_override === b.urgent_override &&
    a.digest_time === b.digest_time &&
    a.stale_threshold_minutes === b.stale_threshold_minutes
  );
}

// The threshold in minutes, or null unless the text is a whole number from 5
// to 240. Blanks, fractions, signs, exponents, and hex are refused.
export function parseThreshold(text: string): number | null {
  const trimmed = text.trim();
  if (!WHOLE_NUMBER.test(trimmed)) {
    return null;
  }
  const minutes = Number(trimmed);
  if (minutes < MIN_STALE_THRESHOLD || minutes > MAX_STALE_THRESHOLD) {
    return null;
  }
  return minutes;
}

// A note for a quiet window that runs past midnight, or null.
export function overnightLabel(start: string, end: string): string | null {
  const from = parseTime(start);
  const to = parseTime(end);
  if (from === null || to === null || from <= to) {
    return null;
  }
  return `Quiet hours run overnight: from ${start} until ${end} the next day.`;
}

export type Validation = { ok: true; args: UpdateArgs } | { ok: false; errors: FieldErrors };

// The draft's update arguments, or the message for each field that is wrong.
export function validateDraft(draft: Draft): Validation {
  const errors: FieldErrors = {};
  if (draft.timeZoneChosen && !isValidTimeZone(draft.timeZone)) {
    errors.timeZone = ZONE_RULE;
  }
  if (draft.quietEnabled) {
    const start = draft.quietStart.trim();
    const end = draft.quietEnd.trim();
    if (start === "") {
      errors.quietStart = MISSING_START;
    } else if (parseTime(start) === null) {
      errors.quietStart = TIME_RULE;
    }
    if (end === "") {
      errors.quietEnd = MISSING_END;
    } else if (parseTime(end) === null) {
      errors.quietEnd = TIME_RULE;
    } else if (start === end) {
      errors.quietEnd = EQUAL_TIMES;
    }
  }
  const digestTime = draft.digestTime.trim();
  if (parseTime(digestTime) === null) {
    errors.digestTime = TIME_RULE;
  }
  const staleThresholdMinutes = parseThreshold(draft.staleThreshold);
  if (staleThresholdMinutes === null) {
    errors.staleThresholdMinutes = THRESHOLD_RULE;
  }
  if (Object.keys(errors).length > 0 || staleThresholdMinutes === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    args: {
      ...(draft.timeZoneChosen ? { timeZone: draft.timeZone } : {}),
      quietStart: draft.quietEnabled ? draft.quietStart.trim() : null,
      quietEnd: draft.quietEnabled ? draft.quietEnd.trim() : null,
      urgentOverride: draft.urgentOverride,
      digestTime,
      staleThresholdMinutes,
    },
  };
}

// The message for an `invalid` refusal naming `field`.
export function refusalMessage(field: SettingsField): string {
  switch (field) {
    case "timeZone":
      return "AgentDesk did not accept this time zone. Choose another.";
    case "quietStart":
      return "AgentDesk did not accept this start time. Quiet hours need a start and an end.";
    case "quietEnd":
      return "AgentDesk did not accept this end time. Quiet hours need a different start and end.";
    case "digestTime":
      return `AgentDesk did not accept this digest time. ${TIME_RULE}`;
    case "staleThresholdMinutes":
      return THRESHOLD_RULE;
  }
}

export function isSettingsField(field: unknown): field is SettingsField {
  return typeof field === "string" && (SETTINGS_FIELDS as readonly string[]).includes(field);
}
