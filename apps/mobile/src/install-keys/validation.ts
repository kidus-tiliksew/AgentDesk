import { errorCodeSchema } from "@agentdesk/contract";
import { HARNESSES, type HarnessId } from "../../../../convex/identity/harnesses";
import { errorData } from "../query-error-boundary";

// The create form's checks (component-mobile-app §Install keys;
// req-install-keys AC-1.2, AC-1.3). The bounds repeat those of
// `identity/installKeys:createInstallKey`, which checks every field again
// and stays the authority; the form only names a bad field before a request
// is sent. The backend module loads Convex server code, so the app cannot
// import its constants.

export const LABEL_MAX = 64;
export const EXPIRY_DAYS_MIN = 1;
export const EXPIRY_DAYS_MAX = 90;
export const MACHINE_LIMIT_MIN = 1;
export const MACHINE_LIMIT_MAX = 100;
export const IDLE_LIMIT_MINUTES_MIN = 15;
export const IDLE_LIMIT_MINUTES_MAX = 24 * 60;

export { HARNESSES, type HarnessId };

// What the person has typed and chosen. Number fields hold the text as
// typed, so a blank or fractional entry can be named rather than coerced.
export type Draft = {
  label: string;
  harnesses: HarnessId[];
  expiresInDays: string;
  machineLimit: string;
  ephemeral: boolean;
  idleLimitMinutes: string;
};

export const INITIAL_DRAFT: Draft = {
  label: "",
  harnesses: [],
  expiresInDays: "30",
  machineLimit: "10",
  ephemeral: false,
  idleLimitMinutes: "60",
};

export type Field = "label" | "harnesses" | "expiresInDays" | "machineLimit" | "idleLimitMinutes";

// The arguments `createInstallKey` takes. `idleLimitMinutes` is present only
// for an ephemeral key, since the backend refuses it otherwise.
export type CreateArgs = {
  label: string;
  harnesses: HarnessId[];
  expiresInDays: number;
  machineLimit: number;
  ephemeral: boolean;
  idleLimitMinutes?: number;
};

export type Errors = Partial<Record<Field, string>>;

export const MESSAGES: Record<Field, string> = {
  label: `Enter a label of 1 to ${LABEL_MAX} characters.`,
  harnesses: "Choose at least one harness.",
  expiresInDays: `Enter a whole number of days from ${EXPIRY_DAYS_MIN} to ${EXPIRY_DAYS_MAX}.`,
  machineLimit: `Enter a whole number of machines from ${MACHINE_LIMIT_MIN} to ${MACHINE_LIMIT_MAX}.`,
  idleLimitMinutes: `Enter a whole number of minutes from ${IDLE_LIMIT_MINUTES_MIN} to ${IDLE_LIMIT_MINUTES_MAX}.`,
};

// The integer the text spells, digits only, or null for blank, signed,
// fractional, or non-numeric text.
function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

function wholeIn(text: string, min: number, max: number): number | null {
  const value = parseWhole(text);
  return value !== null && value >= min && value <= max ? value : null;
}

// Checks every field and answers either the arguments to send or an error
// for each failing field. The label is trimmed; the harnesses keep the
// order HARNESSES lists them in, without repeats.
export function validateDraft(
  draft: Draft,
): { ok: true; args: CreateArgs } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const label = draft.label.trim();
  if (label.length < 1 || label.length > LABEL_MAX) {
    errors.label = MESSAGES.label;
  }
  const harnesses = HARNESSES.map((harness) => harness.id).filter((id) =>
    draft.harnesses.includes(id),
  );
  if (harnesses.length === 0) {
    errors.harnesses = MESSAGES.harnesses;
  }
  const expiresInDays = wholeIn(draft.expiresInDays, EXPIRY_DAYS_MIN, EXPIRY_DAYS_MAX);
  if (expiresInDays === null) {
    errors.expiresInDays = MESSAGES.expiresInDays;
  }
  const machineLimit = wholeIn(draft.machineLimit, MACHINE_LIMIT_MIN, MACHINE_LIMIT_MAX);
  if (machineLimit === null) {
    errors.machineLimit = MESSAGES.machineLimit;
  }
  const idleLimitMinutes = draft.ephemeral
    ? wholeIn(draft.idleLimitMinutes, IDLE_LIMIT_MINUTES_MIN, IDLE_LIMIT_MINUTES_MAX)
    : null;
  if (draft.ephemeral && idleLimitMinutes === null) {
    errors.idleLimitMinutes = MESSAGES.idleLimitMinutes;
  }
  if (
    Object.keys(errors).length > 0 ||
    expiresInDays === null ||
    machineLimit === null ||
    (draft.ephemeral && idleLimitMinutes === null)
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    args: {
      label,
      harnesses,
      expiresInDays,
      machineLimit,
      ephemeral: draft.ephemeral,
      ...(draft.ephemeral && idleLimitMinutes !== null ? { idleLimitMinutes } : {}),
    },
  };
}

const FIELDS: readonly Field[] = [
  "label",
  "harnesses",
  "expiresInDays",
  "machineLimit",
  "idleLimitMinutes",
];

export const CREATE_FAILURE =
  "Could not create the install key. Check your connection and try again.";

// A failed `createInstallKey` as the form shows it: an `invalid` naming a
// known field puts that field's message under it, and any other failure is
// one message for the form. The backend's own text is never shown.
export function createFailure(error: unknown): { field: Field | null; message: string } {
  const data = errorData(error);
  if (data !== null && data.code === errorCodeSchema.enum.invalid) {
    const field = FIELDS.find((name) => name === data.field);
    if (field !== undefined) {
      return { field, message: MESSAGES[field] };
    }
  }
  return { field: null, message: CREATE_FAILURE };
}
