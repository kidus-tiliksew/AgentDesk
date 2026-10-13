import type { FunctionReturnType } from "convex/server";
import { harnessName, parseHarnesses } from "../../../convex/identity/harnesses";
import type { identity } from "../../../convex/identity/refs";

// component-mobile-app §Screens: code normalization, result checks, and the
// local lock window for settings/add-machine (req-accounts-and-connections
// AC-6.2, AC-6.5, AC-6.6).

export type LookupResult = FunctionReturnType<typeof identity.deviceRequests.lookupDeviceRequest>;
export type ApproveResult = FunctionReturnType<typeof identity.deviceRequests.approveDeviceRequest>;
export type DeclineResult = FunctionReturnType<typeof identity.deviceRequests.declineDeviceRequest>;
export type Refusal = Extract<LookupResult, { status: "not_found" | "expired" | "locked" }>;
export type FoundRequest = Extract<LookupResult, { status: "found" }>;

// The backend returns `locked` without its lock deadline, so the screen keeps
// code entry disabled for this conservative local window. The backend still
// checks the lock on every later call.
export const LOCK_WINDOW_MS = 10 * 60_000;

export const CODE_LENGTH = 8;

// The code field's text as typed or pasted: letters uppercased and everything
// but ASCII letters and digits dropped, so "abcd-efgh", "ABCD EFGH", and a
// pasted " ABCD-EFGH\n" all read as ABCDEFGH. It never shortens the code, so
// text with too many characters is refused rather than sent as a different
// code.
export function cleanCodeInput(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// The 8-character code to send, or null when the cleaned input is not one.
// The backend checks the restricted alphabet.
export function normalizeCode(input: string): string | null {
  const code = cleanCodeInput(input);
  return code.length === CODE_LENGTH ? code : null;
}

function isRefusal(value: { status?: unknown }): value is Refusal {
  return value.status === "not_found" || value.status === "expired" || value.status === "locked";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A lookup result the screen can show, or null when the response does not
// match the typed contract.
export function checkLookup(value: unknown): LookupResult | null {
  if (!isObject(value)) {
    return null;
  }
  if (isRefusal(value)) {
    return { status: value.status } as Refusal;
  }
  if (
    value.status !== "found" ||
    typeof value.machineName !== "string" ||
    !Array.isArray(value.harnesses)
  ) {
    return null;
  }
  const harnesses = parseHarnesses(value.harnesses);
  if (harnesses === null) {
    return null;
  }
  return { status: "found", machineName: value.machineName, harnesses };
}

type Outcome = { status: "approved" } | { status: "declined" };

// An approve or decline result, or null when the response is neither the
// expected success nor a refusal.
export function checkOutcome(value: unknown, success: Outcome["status"]): Outcome | Refusal | null {
  if (!isObject(value)) {
    return null;
  }
  if (value.status === success) {
    return { status: success } as Outcome;
  }
  return isRefusal(value) ? ({ status: value.status } as Refusal) : null;
}

export function harnessNames(request: FoundRequest): string[] {
  return request.harnesses.map(harnessName);
}
