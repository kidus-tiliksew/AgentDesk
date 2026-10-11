// Formatting for the connections screen (component-mobile-app §Screens).

// A connection time in the device's locale and time zone, to the minute. The
// backend writes `lastUsedAt` at most once a minute, so seconds would claim a
// precision the value does not have. `options` fixes the locale and time zone
// in tests.
export function formatConnectionTime(
  ms: number,
  options: { locale?: string; timeZone?: string } = {},
): string {
  return new Date(ms).toLocaleString(options.locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
}
