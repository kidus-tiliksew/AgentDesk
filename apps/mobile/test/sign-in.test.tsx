import { fireEvent, screen } from "expo-router/testing-library";
import { clerkApiError, deferred, ensureAccount, signIn, signUp } from "./fakes";
import { renderApp } from "./render";

const inbox = "No pending decisions.";

async function submitEmail(address: string) {
  fireEvent.changeText(await screen.findByLabelText("Email address"), address);
  fireEvent.press(screen.getByRole("button", { name: "Send code" }));
  return await screen.findByLabelText("Code");
}

function submitCode(code: string) {
  fireEvent.changeText(screen.getByLabelText("Code"), code);
  fireEvent.press(screen.getByRole("button", { name: "Verify" }));
}

describe("sign-in", () => {
  // req-accounts-and-connections REQ-2
  test("takes an email, then the emailed code, and signs the person in", async () => {
    renderApp("/sign-in");

    await submitEmail(" a@example.com ");
    expect(signIn.emailCode.sendCode).toHaveBeenCalledWith({ emailAddress: "a@example.com" });
    expect(screen.getByText("Enter the code we sent to a@example.com.")).toBeOnTheScreen();

    submitCode("123456");

    expect(await screen.findByText(inbox)).toBeOnTheScreen();
    expect(signIn.emailCode.verifyCode).toHaveBeenCalledWith({ code: "123456" });
    expect(signIn.finalize).toHaveBeenCalledTimes(1);
    expect(signUp.create).not.toHaveBeenCalled();
    expect(ensureAccount).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname("/");
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

    expect(await screen.findByText(inbox)).toBeOnTheScreen();
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

    expect(
      await screen.findByText("That code is not correct. Check the email and try again."),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText("Code")).toBeOnTheScreen();
    expect(signIn.finalize).not.toHaveBeenCalled();
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
    fireEvent.press(screen.getByRole("button", { name: "Send code" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
  });

  test("a second press while the code is being sent sends nothing", async () => {
    const sending = deferred<{ error: null }>();
    signIn.emailCode.sendCode.mockReturnValueOnce(sending.promise);
    renderApp("/sign-in");

    fireEvent.changeText(await screen.findByLabelText("Email address"), "a@example.com");
    const send = screen.getByRole("button", { name: "Send code" });
    fireEvent.press(send);
    fireEvent.press(send);
    sending.resolve({ error: null });

    expect(await screen.findByLabelText("Code")).toBeOnTheScreen();
    expect(signIn.emailCode.sendCode).toHaveBeenCalledTimes(1);
  });

  test("a different email returns to the email step", async () => {
    renderApp("/sign-in");
    await submitEmail("a@example.com");

    fireEvent.press(screen.getByRole("button", { name: "Use a different email" }));

    expect(await screen.findByLabelText("Email address")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Code")).not.toBeOnTheScreen();
  });
});
