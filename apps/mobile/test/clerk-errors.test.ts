import { clerkMessage, codeMessage, hasClerkCode, IDENTIFIER_NOT_FOUND } from "../src/clerk-errors";
import { clerkApiError, clerkNetworkError } from "./fakes";

// The fixed copy for Clerk's failures. test/sign-in.test.tsx covers the same
// mapping on the sign-in screen.

describe("clerkMessage", () => {
  test.each([
    ["form_param_format_invalid", "Enter a valid email address."],
    ["too_many_requests", "Too many attempts. Wait a moment and try again."],
    [IDENTIFIER_NOT_FOUND, "We could not find that account. Check your email address."],
    ["form_code_incorrect", "That code is not correct. Check the email and try again."],
    ["verification_expired", "That code has expired. Send a new code."],
    ["captcha_invalid", "Something went wrong. Try again."],
    // A code that names an Object property finds no copy.
    ["constructor", "Something went wrong. Try again."],
    ["toString", "Something went wrong. Try again."],
  ])("%s shows fixed copy", (code, copy) => {
    expect(clerkMessage(clerkApiError(code, "Clerk's message", "Clerk's long message"))).toBe(copy);
  });

  test("a failure without API errors shows the connection copy", () => {
    const copy = "Could not connect. Check your connection and try again.";
    expect(clerkMessage(clerkNetworkError())).toBe(copy);
    expect(clerkMessage(new Error(""))).toBe(copy);
    expect(clerkMessage("offline")).toBe(copy);
    expect(clerkMessage(null)).toBe(copy);
    expect(clerkMessage({ errors: "Clerk's message" })).toBe(copy);
  });

  test("malformed API errors show the generic copy", () => {
    const copy = "Something went wrong. Try again.";
    expect(clerkMessage({ errors: [] })).toBe(copy);
    expect(clerkMessage({ errors: [null, "Clerk's message"] })).toBe(copy);
    expect(clerkMessage({ errors: [{ code: 429, message: "Clerk's message" }] })).toBe(copy);
  });
});

describe("codeMessage", () => {
  test("names a wrong or expired code wherever it sits in the list", () => {
    const both = {
      errors: [
        { code: "form_param_nil", message: "Clerk's message" },
        { code: "verification_expired", message: "Clerk's message" },
      ],
    };
    expect(codeMessage(both)).toBe("That code has expired. Send a new code.");
  });

  test("falls back to clerkMessage", () => {
    expect(codeMessage(clerkNetworkError())).toBe(
      "Could not connect. Check your connection and try again.",
    );
  });
});

test("hasClerkCode reads codes only from well-formed entries", () => {
  expect(hasClerkCode(clerkApiError(IDENTIFIER_NOT_FOUND, "x"), IDENTIFIER_NOT_FOUND)).toBe(true);
  expect(hasClerkCode({ errors: [{ message: IDENTIFIER_NOT_FOUND }] }, IDENTIFIER_NOT_FOUND)).toBe(
    false,
  );
  expect(hasClerkCode(new Error(IDENTIFIER_NOT_FOUND), IDENTIFIER_NOT_FOUND)).toBe(false);
});
