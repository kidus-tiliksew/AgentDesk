// Reads the errors Clerk's sign-in and sign-up methods return or throw. An API
// failure carries `errors`, each with a Clerk error code; any other failure,
// such as clerk-js's offline `Error` whose message holds the request URL,
// carries only a message. Only the codes are read: Clerk's `message` and
// `longMessage` and an `Error`'s message are written for developers, so the
// screen shows fixed copy instead.

type ClerkApiError = { code: string };

// Clerk returns this code when no user holds the email address.
export const IDENTIFIER_NOT_FOUND = "form_identifier_not_found";

const CODE_INCORRECT = "form_code_incorrect";
const CODE_EXPIRED = "verification_expired";
const CODE_INCORRECT_MESSAGE = "That code is not correct. Check the email and try again.";
const CODE_EXPIRED_MESSAGE = "That code has expired. Send a new code.";

// Fixed copy for each Clerk error code the email-code flow can meet. A Map, so
// a code such as "constructor" finds nothing.
const CODE_MESSAGES = new Map<string, string>([
  [CODE_INCORRECT, CODE_INCORRECT_MESSAGE],
  [CODE_EXPIRED, CODE_EXPIRED_MESSAGE],
  ["form_param_format_invalid", "Enter a valid email address."],
  ["too_many_requests", "Too many attempts. Wait a moment and try again."],
  [IDENTIFIER_NOT_FOUND, "We could not find that account. Check your email address."],
]);

// An API failure with a code this app does not know, or a malformed one.
const UNKNOWN_CODE_MESSAGE = "Something went wrong. Try again.";

// A failure with no API errors, such as no network.
const NO_API_MESSAGE = "Could not connect. Check your connection and try again.";

// The error's `errors` array, or null when it has none.
function errorList(error: unknown): unknown[] | null {
  if (typeof error === "object" && error !== null && "errors" in error) {
    const { errors } = error;
    if (Array.isArray(errors)) {
      return errors;
    }
  }
  return null;
}

function apiErrors(error: unknown): ClerkApiError[] {
  return (errorList(error) ?? []).filter(
    (item): item is ClerkApiError =>
      typeof item === "object" && item !== null && "code" in item && typeof item.code === "string",
  );
}

export function hasClerkCode(error: unknown, code: string) {
  return apiErrors(error).some((item) => item.code === code);
}

export function clerkMessage(error: unknown) {
  if (errorList(error) === null) {
    return NO_API_MESSAGE;
  }
  const first = apiErrors(error)[0];
  return (first === undefined ? undefined : CODE_MESSAGES.get(first.code)) ?? UNKNOWN_CODE_MESSAGE;
}

// The message for a failed code verification. A wrong code and an expired
// code each get their own message; both keep the person on the code step.
export function codeMessage(error: unknown) {
  if (hasClerkCode(error, CODE_INCORRECT)) {
    return CODE_INCORRECT_MESSAGE;
  }
  if (hasClerkCode(error, CODE_EXPIRED)) {
    return CODE_EXPIRED_MESSAGE;
  }
  return clerkMessage(error);
}
