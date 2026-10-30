import type { FunctionReturnType } from "convex/server";
import { harnessName } from "../../../../convex/identity/harnesses";
import type { identity } from "../../../../convex/identity/refs";
import { formatConnectionDay } from "../connections/format";
import { formatElapsed } from "../use-screen-clock";

// Formatting for listed install keys (component-mobile-app §Install keys;
// req-install-keys AC-3.1). A listed key never carries its secret or hash.

export type InstallKey = FunctionReturnType<typeof identity.installKeys.listInstallKeys>[number];

type DayOptions = { locale?: string; timeZone?: string };

export function harnessList(key: Pick<InstallKey, "harnesses">): string {
  return key.harnesses.map(harnessName).join(", ");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// An idle limit in minutes as whole hours where it divides evenly:
// "45 minutes", "2 hours".
export function formatIdleLimit(minutes: number): string {
  return minutes % 60 === 0 ? plural(minutes / 60, "hour") : plural(minutes, "minute");
}

// "Ephemeral, ends after 1 hour idle" or "Persistent".
export function lifetimeLine(key: Pick<InstallKey, "ephemeral" | "idleLimitMinutes">): string {
  if (!key.ephemeral || key.idleLimitMinutes === undefined) {
    return "Persistent";
  }
  return `Ephemeral, ends after ${formatIdleLimit(key.idleLimitMinutes)} idle`;
}

export function isExpired(key: Pick<InstallKey, "expiresAt">, now: number): boolean {
  return key.expiresAt <= now;
}

// "Created Oct 12 · expires Nov 11", or "Created Oct 12 · expired Nov 11"
// once the expiry has passed. An expired key stays listed until revoked.
export function datesLine(
  key: Pick<InstallKey, "createdAt" | "expiresAt">,
  now: number,
  options: DayOptions = {},
): string {
  const created = `Created ${formatConnectionDay(key.createdAt, now, options)}`;
  const verb = isExpired(key, now) ? "expired" : "expires";
  return `${created} · ${verb} ${formatConnectionDay(key.expiresAt, now, options)}`;
}

// "2 of 10 machines connected · used 5m ago", or "· never used" before the
// first enrollment. `machinesConnected` comes from the backend, which counts
// machines, not harness connections.
export function usageLine(
  key: Pick<InstallKey, "machinesConnected" | "machineLimit" | "lastUsedAt">,
  now: number,
): string {
  const machines = `${key.machinesConnected} of ${plural(key.machineLimit, "machine")} connected`;
  if (key.lastUsedAt === undefined) {
    return `${machines} · never used`;
  }
  return `${machines} · used ${formatElapsed(new Date(key.lastUsedAt).toISOString(), now)}`;
}

// The same facts for VoiceOver, in whole words.
export function spokenKeySummary(key: InstallKey, now: number, options: DayOptions = {}): string {
  const parts = [
    isExpired(key, now) ? "Expired" : null,
    harnessList(key),
    lifetimeLine(key),
    datesLine(key, now, options).replace(" · ", ", "),
    `${key.machinesConnected} of ${plural(key.machineLimit, "machine")} connected`,
    key.lastUsedAt === undefined ? "never used" : `last used ${spokenAgo(now - key.lastUsedAt)}`,
  ];
  return parts.filter((part) => part !== null).join(". ");
}

function spokenAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (seconds < 60) {
    return `${plural(seconds, "second")} ago`;
  }
  if (minutes < 60) {
    return `${plural(minutes, "minute")} ago`;
  }
  if (hours < 24) {
    return `${plural(hours, "hour")} ago`;
  }
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

// The revoke switch's label, with the backend's machine count
// (req-install-keys AC-3.2).
export function revokeConnectionsLabel(machinesConnected: number): string {
  return `Also disconnect ${plural(machinesConnected, "machine")} connected with this key`;
}
