import { formatElapsed } from "../use-screen-clock";

// Formatting and grouping for the connections screen (component-mobile-app
// §Screens, req-accounts-and-connections AC-4.1).

type Times = { firstConnectedAt: number; lastUsedAt?: number; installKeyLabel?: string };

// The install key that made a connection (req-install-keys AC-3.3).
export function viaInstallKey(label: string): string {
  return `via ${label}`;
}

// The day a connection was first made, e.g. "Oct 12", with the year when it
// is not the current one. `options` fixes the locale and time zone in tests.
export function formatConnectionDay(
  ms: number,
  now: number,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  const year = (at: number) => new Date(at).toLocaleString("en-US", { year: "numeric", ...zone });
  return new Date(ms).toLocaleDateString(options.locale, {
    month: "short",
    day: "numeric",
    ...(year(ms) === year(now) ? {} : { year: "numeric" }),
    ...zone,
  });
}

// One line with both connection times: "Connected Oct 12 · used 2m ago" or
// "Connected Oct 12 · never used". The backend writes `lastUsedAt` at most
// once a minute, so the elapsed time is rough at the scale of seconds.
export function connectionSummary(
  connection: Times,
  now: number,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const connected = `Connected ${formatConnectionDay(connection.firstConnectedAt, now, options)}`;
  if (connection.lastUsedAt === undefined) {
    return `${connected} · never used`;
  }
  return `${connected} · used ${formatElapsed(new Date(connection.lastUsedAt).toISOString(), now)}`;
}

// The same times for VoiceOver, with whole words where the visible line
// abbreviates: "Connected Oct 12, last used 2 minutes ago". VoiceOver would
// read the visible "2m" as meters.
export function connectionSpokenSummary(
  connection: Times,
  now: number,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const connected = `Connected ${formatConnectionDay(connection.firstConnectedAt, now, options)}`;
  const via =
    connection.installKeyLabel === undefined
      ? ""
      : `, ${viaInstallKey(connection.installKeyLabel)}`;
  if (connection.lastUsedAt === undefined) {
    return `${connected}${via}, never used`;
  }
  return `${connected}${via}, last used ${spokenElapsed(now - connection.lastUsedAt)}`;
}

// Whole seconds, minutes, hours, or days, as formatElapsed counts them.
function spokenElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const [count, unit] =
    seconds < 60
      ? [seconds, "second"]
      : minutes < 60
        ? [minutes, "minute"]
        : hours < 24
          ? [hours, "hour"]
          : [Math.floor(hours / 24), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export const OTHER_MACHINE = "Other";

// Connections grouped by machine name, in the order each machine first
// appears in the query, with connections of no known machine last under
// "Other". Rows keep their query order inside a group.
export function groupByMachine<T extends { machineName?: string }>(
  connections: readonly T[],
): { machine: string; connections: T[] }[] {
  const groups = new Map<string, T[]>();
  const other: T[] = [];
  for (const connection of connections) {
    if (connection.machineName === undefined) {
      other.push(connection);
      continue;
    }
    const group = groups.get(connection.machineName);
    if (group === undefined) {
      groups.set(connection.machineName, [connection]);
    } else {
      group.push(connection);
    }
  }
  const named = [...groups].map(([machine, rows]) => ({ machine, connections: rows }));
  return other.length === 0 ? named : [...named, { machine: OTHER_MACHINE, connections: other }];
}
