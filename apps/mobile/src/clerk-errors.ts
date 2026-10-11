// Reads the errors Clerk's sign-in and sign-up methods return. An API failure
// carries `errors`, each with a Clerk error code; any other failure carries
// only a message.

type ClerkApiError = { code: string; message: string; longMessage?: string };

function apiErrors(error: unknown): ClerkApiError[] {
  if (typeof error === "object" && error !== null && "errors" in error) {
    const { errors } = error;
    if (Array.isArray(errors)) {
      return errors.filter(
        (item): item is ClerkApiError =>
          typeof item === "object" && item !== null && typeof item.code === "string",
      );
    }
  }
  return [];
}

export function hasClerkCode(error: unknown, code: string) {
  return apiErrors(error).some((item) => item.code === code);
}

// Clerk returns this code when no user holds the email address.
export const IDENTIFIER_NOT_FOUND = "form_identifier_not_found";

export function clerkMessage(error: unknown) {
  const first = apiErrors(error)[0];
  if (first !== undefined) {
    return first.longMessage ?? first.message;
  }
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "Something went wrong. Try again.";
}

// The message for a failed code verification. A wrong code and an expired
// code each get their own message; both keep the person on the code step.
export function codeMessage(error: unknown) {
  if (hasClerkCode(error, "form_code_incorrect")) {
    return "That code is not correct. Check the email and try again.";
  }
  if (hasClerkCode(error, "verification_expired")) {
    return "That code has expired. Send a new code.";
  }
  return clerkMessage(error);
}
