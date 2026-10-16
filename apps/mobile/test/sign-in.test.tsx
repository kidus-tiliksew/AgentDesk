import { act, fireEvent, screen } from "expo-router/testing-library";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { PRIVACY_POLICY_URL } from "../src/config";
import { haptic } from "../src/haptics";
import {
  clerkApiError,
  clerkNetworkError,
  deferred,
  ensureAccount,
  signIn,
  signUp,
  webBrowser,
} from "./fakes";
import { findInbox, renderApp } from "./render";

beforeEach(() => {
  // React Native's preset already mocks this function, so the spy is that
  // mock and keeps earlier tests' calls until cleared.
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockClear();
  jest.spyOn(haptic, "success");
  jest.spyOn(haptic, "error");
});

afterEach(() => {
  jest.restoreAllMocks();
});

function announced() {
  return jest.mocked(AccessibilityInfo.announceForAccessibility).mock.calls.map(([text]) => text);
}

const WRONG_CODE = "That code is not correct. Check the email and try again.";
const RATE_LIMITED = "Too many attempts. Wait a moment and try again.";
const NO_CONNECTION = "Could not connect. Check your connection and try again.";

// Clerk's own text, written for developers, as clerk-js reports it. Each
// differs from the app's copy, so a pass-through would show.
const TOO_MANY = ["Too many requests", "Too many requests. Please try again in a bit."] as const;
// The offline Error's message holds the request URL.
const NETWORK_TEXT = ["ClerkJS", "Network error at", "clerk.agentdesk.example", "/v1/client/"];

// Fails the test if any of `texts` reached the screen or VoiceOver.
function expectNotShown(...texts: readonly string[]) {
  for (const text of texts) {
    expect(screen.queryByText(text, { exact: false })).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(text, { exact: false })).not.toBeOnTheScreen();
    expect(announced().filter((said) => said.includes(text))).toEqual([]);
  }
}

async function submitEmail(address: string) {
  fireEvent.changeText(await screen.findByLabelText("Email address"), address);
  fireEvent.press(screen.getByRole("button", { name: "Continue" }));
  return await screen.findByLabelText("Code");
}

// Typing the sixth digit submits the code; no button press is needed.
function submitCode(code: string) {
  fireEvent.changeText(screen.getByLabelText("Code"), code);
}

// One press of the Privacy Policy link opens the privacy policy once.
function expectPrivacyLinkOpensPolicy() {
  fireEvent.press(screen.getByRole("link", { name: "Privacy Policy" }));
  expect(PRIVACY_POLICY_URL).toBe("https://agentdesk.kidus.sh/privacy");
  expect(webBrowser.openBrowserAsync).toHaveBeenCalledTimes(1);
  expect(webBrowser.openBrowserAsync).toHaveBeenCalledWith("https://agentdesk.kidus.sh/privacy");
}

// The code step names the address the code went to.
function expectCodeStepFor(address: string) {
  expect(screen.getByRole("header", { name: "Check your email" })).toBeOnTheScreen();
  expect(screen.getByText(address)).toBeOnTheScreen();
}

describe("sign-in", () => {
  // req-accounts-and-connections REQ-2
  test("takes an email, then the emailed code, and signs the person in", async () => {
    renderApp("/sign-in");

    await submitEmail(" a@example.com ");
    expect(signIn.emailCode.sendCode).toHaveBeenCalledWith({ emailAddress: "a@example.com" });
    expectCodeStepFor("a@example.com");

    submitCode("123456");

    expect(await findInbox()).toBeOnTheScreen();
    expect(signIn.emailCode.verifyCode).toHaveBeenCalledWith({ code: "123456" });
    expect(signIn.finalize).toHaveBeenCalledTimes(1);
    expect(signUp.create).not.toHaveBeenCalled();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname("/");
    // Apple HIG Playing haptics: signing in is felt as a success.
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(haptic.error).not.toHaveBeenCalled();
  });

  // req-accounts-and-connections AC-2.1
  test("signs up an address that holds no Clerk user through the same two steps", async () => {
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });
    renderApp("/sign-in");

    await submitEmail("new@example.com");
    expect(signUp.create).toHaveBeenCalledWith({ emailAddress: "new@example.com" });
    expect(signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(1);

    submitCode("654321");

    expect(await findInbox()).toBeOnTheScreen();
    expect(signUp.verifications.verifyEmailCode).toHaveBeenCalledWith({ code: "654321" });
    expect(signUp.finalize).toHaveBeenCalledTimes(1);
    expect(signIn.emailCode.verifyCode).not.toHaveBeenCalled();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
  });

  test("a wrong code shows an error and keeps the person on the code step", async () => {
    signIn.emailCode.verifyCode.mockResolvedValueOnce({
      error: clerkApiError("form_code_incorrect", "is incorrect", "Incorrect code"),
    });
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    submitCode("000000");

    expect(await screen.findByText(WRONG_CODE)).toBeOnTheScreen();
    expect(screen.getByLabelText("Code")).toBeOnTheScreen();
    expect(signIn.finalize).not.toHaveBeenCalled();
    // The error is felt and spoken to VoiceOver as it appears.
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(announced()).toEqual([WRONG_CODE]);
    expectNotShown("is incorrect", "Incorrect code");
    expect(screen).toHavePathname("/sign-in");
  });

  test("an expired code shows an error, keeps the code step, and can send a new code", async () => {
    signUp.verifications.verifyEmailCode.mockResolvedValueOnce({
      error: clerkApiError(
        "verification_expired",
        "expired",
        "This verification has expired. You must create a new one.",
      ),
    });
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });
    renderApp("/sign-in");
    await submitEmail("new@example.com");

    submitCode("111111");

    expect(await screen.findByText("That code has expired. Send a new code.")).toBeOnTheScreen();
    expect(announced()).toEqual(["That code has expired. Send a new code."]);
    expectNotShown("This verification has expired", "create a new one");
    expect(screen.getByLabelText("Code")).toBeOnTheScreen();
    expect(signUp.finalize).not.toHaveBeenCalled();

    // A new code is offered once the resend wait has passed.
    act(() => jest.advanceTimersByTime(30_000));
    fireEvent.press(screen.getByRole("button", { name: "Send a new code" }));
    await screen.findByLabelText("Code");
    expect(signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(2);
  });

  test("an invalid address keeps the email step with fixed copy, never Clerk's text", async () => {
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError(
        "form_param_format_invalid",
        "is invalid",
        "email_address must be a valid email address.",
      ),
    });
    renderApp("/sign-in");

    fireEvent.changeText(await screen.findByLabelText("Email address"), "not-an-email");
    fireEvent.press(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
    expect(announced()).toEqual(["Enter a valid email address."]);
    expectNotShown("is invalid", "email_address");
  });

  // Each failure of the send, returned or thrown, shows only fixed copy:
  // Clerk's codes choose it, and Clerk's text and an Error's message never
  // reach the screen or VoiceOver.
  test.each([
    {
      name: "rate limiting",
      fail: async () => ({ error: clerkApiError("too_many_requests", ...TOO_MANY, 429) }),
      copy: RATE_LIMITED,
      clerkText: TOO_MANY,
    },
    {
      name: "an unknown Clerk code",
      fail: async () => ({
        error: clerkApiError(
          "captcha_invalid",
          "CAPTCHA failed",
          "Sign up unsuccessful due to failed security validations.",
        ),
      }),
      copy: "Something went wrong. Try again.",
      clerkText: ["CAPTCHA failed", "security validations"],
    },
    {
      name: "an error entry without a code",
      fail: async () => ({ error: { errors: [{ message: "Clerk refused the request" }] } }),
      copy: "Something went wrong. Try again.",
      clerkText: ["Clerk refused the request"],
    },
    {
      name: "an error entry with a malformed code",
      fail: async () => ({
        error: { errors: [{ code: 422, message: "Clerk refused the request" }] },
      }),
      copy: "Something went wrong. Try again.",
      clerkText: ["Clerk refused the request"],
    },
    {
      name: "an empty errors list",
      fail: async () => ({
        error: Object.assign(new Error("Clerk refused the request"), { errors: [] }),
      }),
      copy: "Something went wrong. Try again.",
      clerkText: ["Clerk refused the request"],
    },
    {
      name: "a returned network error",
      fail: async () => ({ error: clerkNetworkError() }),
      copy: NO_CONNECTION,
      clerkText: NETWORK_TEXT,
    },
    {
      name: "a thrown network error",
      fail: async () => {
        throw clerkNetworkError();
      },
      copy: NO_CONNECTION,
      clerkText: NETWORK_TEXT,
    },
  ])("a send failing with $name keeps the email step with fixed copy", async (failure) => {
    signIn.emailCode.sendCode.mockImplementationOnce(failure.fail);
    renderApp("/sign-in");

    fireEvent.changeText(await screen.findByLabelText("Email address"), "a@example.com");
    fireEvent.press(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(failure.copy)).toBeOnTheScreen();
    expect(announced()).toEqual([failure.copy]);
    expectNotShown(...failure.clerkText);
    expect(screen.getByLabelText("Email address")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
    expect(signUp.create).not.toHaveBeenCalled();
  });

  test("a first sign-in whose code cannot be sent shows the connection copy", async () => {
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });
    signUp.verifications.sendEmailCode.mockResolvedValueOnce({
      error: clerkNetworkError("sign_ups/sua_1/prepare_verification"),
    });
    renderApp("/sign-in");

    fireEvent.changeText(await screen.findByLabelText("Email address"), "new@example.com");
    fireEvent.press(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(NO_CONNECTION)).toBeOnTheScreen();
    expect(announced()).toEqual([NO_CONNECTION]);
    expectNotShown(...NETWORK_TEXT, "Couldn't find your account");
    expect(signUp.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
  });

  test("a thrown verification failure keeps the code step with the connection copy", async () => {
    signIn.emailCode.verifyCode.mockRejectedValueOnce(
      clerkNetworkError("sign_ins/sia_1/attempt_first_factor"),
    );
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    submitCode("123456");

    expect(await screen.findByText(NO_CONNECTION)).toBeOnTheScreen();
    expect(announced()).toEqual([NO_CONNECTION]);
    expectNotShown(...NETWORK_TEXT);
    expect(screen.getByLabelText("Code")).toBeOnTheScreen();
    expect(signIn.finalize).not.toHaveBeenCalled();
  });

  test("a resend for an account removed since the first send says the account was not found", async () => {
    renderApp("/sign-in");
    await submitEmail("a@example.com");
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });

    act(() => jest.advanceTimersByTime(30_000));
    fireEvent.press(screen.getByRole("button", { name: "Send a new code" }));

    const notFound = "We could not find that account. Check your email address.";
    expect(await screen.findByText(notFound)).toBeOnTheScreen();
    expect(announced()).toEqual([notFound]);
    expectNotShown("Couldn't find your account");
    expect(screen.getByLabelText("Code")).toBeOnTheScreen();
    expect(signUp.create).not.toHaveBeenCalled();
  });

  test("a second press while the code is being sent sends nothing", async () => {
    const sending = deferred<{ error: null }>();
    signIn.emailCode.sendCode.mockReturnValueOnce(sending.promise);
    renderApp("/sign-in");

    fireEvent.changeText(await screen.findByLabelText("Email address"), "a@example.com");
    const send = screen.getByRole("button", { name: "Continue" });
    fireEvent.press(send);
    fireEvent.press(send);
    sending.resolve({ error: null });

    expect(await screen.findByLabelText("Code")).toBeOnTheScreen();
    expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(1);
  });

  // A verified sign-up that Clerk still holds incomplete, for example because
  // the instance requires a password, cannot finish.
  test("an incomplete sign-up offers a fresh sign-up for the same address", async () => {
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });
    signUp.verifications.verifyEmailCode.mockResolvedValueOnce({ error: null });
    renderApp("/sign-in");
    await submitEmail("new@example.com");

    submitCode("111111");

    expect(
      await screen.findByText(
        "Sign-up needs details the app does not collect. Check the Clerk settings.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("Signing up new@example.com did not finish.")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeOnTheScreen();
    expect(signUp.finalize).not.toHaveBeenCalled();
    expect(announced()).toEqual([
      "Sign-up needs details the app does not collect. Check the Clerk settings.",
    ]);

    fireEvent.press(screen.getByRole("button", { name: "Start sign-up again" }));

    expect(await screen.findByRole("header", { name: "Check your email" })).toBeOnTheScreen();
    expect(screen.getByText("new@example.com")).toBeOnTheScreen();
    expect(signUp.create).toHaveBeenCalledTimes(2);
    expect(signUp.create).toHaveBeenLastCalledWith({ emailAddress: "new@example.com" });
    expect(signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Code")).toHaveDisplayValue("");

    submitCode("222222");

    expect(await findInbox()).toBeOnTheScreen();
    expect(signUp.verifications.verifyEmailCode).toHaveBeenCalledTimes(2);
    expect(signUp.verifications.verifyEmailCode).toHaveBeenLastCalledWith({ code: "222222" });
    expect(signUp.finalize).toHaveBeenCalledTimes(1);
    expect(ensureAccount).toHaveBeenCalledTimes(1);
  });

  test("a failed fresh sign-up keeps the recovery step with fixed copy", async () => {
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });
    signUp.verifications.verifyEmailCode.mockResolvedValueOnce({ error: null });
    renderApp("/sign-in");
    await submitEmail("new@example.com");
    submitCode("111111");
    await screen.findByText("Signing up new@example.com did not finish.");

    signUp.create.mockResolvedValueOnce({
      error: clerkApiError("too_many_requests", ...TOO_MANY, 429),
    });
    fireEvent.press(screen.getByRole("button", { name: "Start sign-up again" }));

    expect(await screen.findByText(RATE_LIMITED)).toBeOnTheScreen();
    expectNotShown(...TOO_MANY);
    expect(screen.getByRole("button", { name: "Start sign-up again" })).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
    expect(signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByRole("button", { name: "Use a different email" }));
    expect(await screen.findByLabelText("Email address")).toHaveDisplayValue("new@example.com");
  });

  test("Verify after a failed finalize finalizes again without re-submitting the code", async () => {
    signIn.finalize.mockResolvedValueOnce({ error: clerkNetworkError("sessions/sess_1/touch") });
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    submitCode("123456");

    expect(await screen.findByText(NO_CONNECTION)).toBeOnTheScreen();
    expect(signIn.emailCode.verifyCode).toHaveBeenCalledTimes(1);
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(announced()).toEqual([NO_CONNECTION]);
    expectNotShown(...NETWORK_TEXT);

    fireEvent.press(screen.getByRole("button", { name: "Verify" }));

    expect(await findInbox()).toBeOnTheScreen();
    expect(signIn.emailCode.verifyCode).toHaveBeenCalledTimes(1);
    expect(signIn.finalize).toHaveBeenCalledTimes(2);
    expect(haptic.success).toHaveBeenCalledTimes(1);
  });

  test("a completed sign-up verification is not re-submitted when finalize is retried", async () => {
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });
    signUp.finalize.mockResolvedValueOnce({ error: clerkNetworkError("sessions/sess_1/touch") });
    renderApp("/sign-in");
    await submitEmail("new@example.com");

    submitCode("654321");
    expect(await screen.findByText(NO_CONNECTION)).toBeOnTheScreen();
    expectNotShown(...NETWORK_TEXT);

    fireEvent.press(screen.getByRole("button", { name: "Verify" }));

    expect(await findInbox()).toBeOnTheScreen();
    expect(signUp.verifications.verifyEmailCode).toHaveBeenCalledTimes(1);
    expect(signUp.finalize).toHaveBeenCalledTimes(2);
  });

  test("a different email returns to the email step", async () => {
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    fireEvent.press(screen.getByRole("button", { name: "Use a different email" }));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
  });

  test("the code submits by itself on the sixth digit and not before", async () => {
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    fireEvent.changeText(screen.getByLabelText("Code"), "12345");
    expect(signIn.emailCode.verifyCode).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByLabelText("Code"), "123456");

    expect(await findInbox()).toBeOnTheScreen();
    expect(signIn.emailCode.verifyCode).toHaveBeenCalledTimes(1);
    expect(signIn.emailCode.verifyCode).toHaveBeenCalledWith({ code: "123456" });
  });

  test("the code field takes six digits from the number pad and one-time-code autofill", async () => {
    renderApp("/sign-in");
    const field = await submitEmail("a@example.com");

    // A pasted code drops separators before it is checked.
    fireEvent.changeText(field, "12-34 56");
    expect(signIn.emailCode.verifyCode).toHaveBeenCalledWith({ code: "123456" });

    expect(field.props.inputMode).toBe("numeric");
    expect(field.props.textContentType).toBe("oneTimeCode");
    expect(field.props.autoComplete).toBe("one-time-code");
  });

  test("Verify submits a typed code and asks for one when the boxes are empty", async () => {
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    fireEvent.press(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Enter the code from the email.")).toBeOnTheScreen();
    expect(signIn.emailCode.verifyCode).not.toHaveBeenCalled();
  });

  test("a new code is offered after a 30 second countdown, which restarts on resend", async () => {
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    expect(screen.getByText("Resend code in 0:30")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Send a new code" })).toBeNull();

    act(() => jest.advanceTimersByTime(6_000));
    expect(screen.getByText("Resend code in 0:24")).toBeOnTheScreen();

    act(() => jest.advanceTimersByTime(24_000));
    expect(screen.queryByText(/^Resend code in/)).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Send a new code" }));
    });

    expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(2);
    expect(signIn.emailCode.sendCode).toHaveBeenLastCalledWith();
    expect(screen.getByText("Resend code in 0:30")).toBeOnTheScreen();
  });

  test("the email step shows the app mark and explains the emailed code", async () => {
    renderApp("/sign-in");

    expect(await screen.findByRole("header", { name: "AgentDesk" })).toBeOnTheScreen();
    expect(screen.getByText("Answer your coding agents from anywhere.")).toBeOnTheScreen();
    expect(screen.getByText("We'll email you a 6-digit code. No password.")).toBeOnTheScreen();
  });

  // req-mobile-app AC-7.2
  test("the email step's Privacy Policy link opens the privacy policy and keeps the step", async () => {
    renderApp("/sign-in");
    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();

    expectPrivacyLinkOpensPolicy();

    // Opening the policy starts no sign-in and leaves the screen as it was.
    expect(signIn.emailCode.sendCode).not.toHaveBeenCalled();
    expect(signUp.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email address")).toBeOnTheScreen();
    expect(screen).toHavePathname("/sign-in");
  });

  // req-mobile-app AC-7.2
  test("the code step's Privacy Policy link opens the privacy policy and keeps the step", async () => {
    renderApp("/sign-in");
    await submitEmail("a@example.com");
    expectCodeStepFor("a@example.com");

    expectPrivacyLinkOpensPolicy();

    expect(signIn.emailCode.verifyCode).not.toHaveBeenCalled();
    expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(1);
    expectCodeStepFor("a@example.com");
    expect(screen).toHavePathname("/sign-in");
  });

  test("an email error and a code error stay shown with the Privacy Policy link", async () => {
    signIn.emailCode.verifyCode.mockResolvedValueOnce({
      error: clerkApiError("form_code_incorrect", "is incorrect", "Incorrect code"),
    });
    renderApp("/sign-in");

    fireEvent.press(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Enter your email address.")).toBeOnTheScreen();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toBeOnTheScreen();

    await submitEmail("a@example.com");
    submitCode("000000");
    expect(await screen.findByText(WRONG_CODE)).toBeOnTheScreen();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toBeOnTheScreen();
    expect(webBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  // Apple HIG Typography and Buttons.
  test("the email field grows with Dynamic Type and the Change link is a 44pt target", async () => {
    renderApp("/sign-in");
    const field = await screen.findByLabelText("Email address");
    const style = StyleSheet.flatten(field.props.style);
    expect(style.height).toBeUndefined();
    expect(style.minHeight).toBe(50);

    await submitEmail("a@example.com");

    const change = screen.getByRole("button", { name: "Use a different email" });
    expect(change.props.hitSlop).toEqual({ top: 12, bottom: 12, left: 8, right: 8 });
  });
});
