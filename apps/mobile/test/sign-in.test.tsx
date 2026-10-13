import { act, fireEvent, screen } from "expo-router/testing-library";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { haptic } from "../src/haptics";
import { clerkApiError, deferred, ensureAccount, signIn, signUp } from "./fakes";
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

async function submitEmail(address: string) {
  fireEvent.changeText(await screen.findByLabelText("Email address"), address);
  fireEvent.press(screen.getByRole("button", { name: "Continue" }));
  return await screen.findByLabelText("Code");
}

// Typing the sixth digit submits the code; no button press is needed.
function submitCode(code: string) {
  fireEvent.changeText(screen.getByLabelText("Code"), code);
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
      error: clerkApiError("form_code_incorrect", "Incorrect code"),
    });
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    submitCode("000000");

    const wrong = "That code is not correct. Check the email and try again.";
    expect(await screen.findByText(wrong)).toBeOnTheScreen();
    expect(screen.getByLabelText("Code")).toBeOnTheScreen();
    expect(signIn.finalize).not.toHaveBeenCalled();
    // The error is felt and spoken to VoiceOver as it appears.
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(announced()).toEqual([wrong]);
    expect(screen).toHavePathname("/sign-in");
  });

  test("an expired code shows an error, keeps the code step, and can send a new code", async () => {
    signUp.verifications.verifyEmailCode.mockResolvedValueOnce({
      error: clerkApiError("verification_expired", "Code expired"),
    });
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });
    renderApp("/sign-in");
    await submitEmail("new@example.com");

    submitCode("111111");

    expect(await screen.findByText("That code has expired. Send a new code.")).toBeOnTheScreen();
    expect(screen.getByLabelText("Code")).toBeOnTheScreen();
    expect(signUp.finalize).not.toHaveBeenCalled();

    // A new code is offered once the resend wait has passed.
    act(() => jest.advanceTimersByTime(30_000));
    fireEvent.press(screen.getByRole("button", { name: "Send a new code" }));
    await screen.findByLabelText("Code");
    expect(signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(2);
  });

  test("a failed send keeps the email step and shows Clerk's message", async () => {
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_param_format_invalid", "Enter a valid email address."),
    });
    renderApp("/sign-in");

    fireEvent.changeText(await screen.findByLabelText("Email address"), "not-an-email");
    fireEvent.press(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
    expect(announced()).toEqual(["Enter a valid email address."]);
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

  test("a failed fresh sign-up keeps the recovery step and shows Clerk's message", async () => {
    signIn.emailCode.sendCode.mockResolvedValueOnce({
      error: clerkApiError("form_identifier_not_found", "Couldn't find your account."),
    });
    signUp.verifications.verifyEmailCode.mockResolvedValueOnce({ error: null });
    renderApp("/sign-in");
    await submitEmail("new@example.com");
    submitCode("111111");
    await screen.findByText("Signing up new@example.com did not finish.");

    signUp.create.mockResolvedValueOnce({
      error: clerkApiError("too_many_requests", "Too many requests. Try again later."),
    });
    fireEvent.press(screen.getByRole("button", { name: "Start sign-up again" }));

    expect(await screen.findByText("Too many requests. Try again later.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Start sign-up again" })).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
    expect(signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByRole("button", { name: "Use a different email" }));
    expect(await screen.findByLabelText("Email address")).toHaveDisplayValue("new@example.com");
  });

  test("Verify after a failed finalize finalizes again without re-submitting the code", async () => {
    signIn.finalize.mockResolvedValueOnce({
      error: clerkApiError("network_error", "Could not reach Clerk."),
    });
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    submitCode("123456");

    expect(await screen.findByText("Could not reach Clerk.")).toBeOnTheScreen();
    expect(signIn.emailCode.verifyCode).toHaveBeenCalledTimes(1);
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(announced()).toEqual(["Could not reach Clerk."]);

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
    signUp.finalize.mockResolvedValueOnce({
      error: clerkApiError("network_error", "Could not reach Clerk."),
    });
    renderApp("/sign-in");
    await submitEmail("new@example.com");

    submitCode("654321");
    expect(await screen.findByText("Could not reach Clerk.")).toBeOnTheScreen();

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
