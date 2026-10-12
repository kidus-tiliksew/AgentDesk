// component-identity §Short-code sign-in: the fixed set of harnesses the
// installer connects, with the display name each minted connection stores in
// `name` (req-accounts-and-connections AC-4.1, AC-6.4). This module imports
// nothing from Convex, so the gateway, installer, and app can import it.

export const HARNESSES = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
] as const;

export type HarnessId = (typeof HARNESSES)[number]["id"];

export const HARNESS_IDS: readonly HarnessId[] = HARNESSES.map((harness) => harness.id);

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}

// Returns the display name of a harness id.
export function harnessName(id: HarnessId): string {
  const harness = HARNESSES.find((entry) => entry.id === id);
  if (harness === undefined) {
    throw new Error(`Unknown harness ${id}`);
  }
  return harness.name;
}

// Returns the list in its given order when it is a non-empty list of distinct
// known harness ids, and null otherwise.
export function parseHarnesses(values: readonly unknown[]): HarnessId[] | null {
  if (values.length === 0) {
    return null;
  }
  const seen = new Set<HarnessId>();
  for (const value of values) {
    if (!isHarnessId(value) || seen.has(value)) {
      return null;
    }
    seen.add(value);
  }
  return [...seen];
}
