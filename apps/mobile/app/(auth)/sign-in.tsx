import { useSignIn, useSignUp } from "@clerk/expo";
import { useRef, useState } from "react";
import { Pressable, Text, TextInput } from "react-native";
import { Button } from "../../src/button";
import {
  clerkMessage,
  codeMessage,
  hasClerkCode,
  IDENTIFIER_NOT_FOUND,
} from "../../src/clerk-errors";
import { HeaderlessScreen } from "../../src/headerless-screen";
import { styles } from "../../src/styles";

// component-mobile-app §Screens `(auth)/sign-in`: an email address, then the
// code Clerk emails to it, with no password (req-accounts-and-connections
// REQ-2). An address that holds no Clerk user signs up through the same two
// steps. Finalizing activates the Clerk session; the (auth) layout then
// redirects to the app, whose layout creates the account. A sign-up whose
// code verified but that Clerk still holds incomplete cannot go on, so the
// screen offers a fresh sign-up for the same address instead of the code step.

type Flow = "signIn" | "signUp";
type Step =
  | { kind: "email" }
  | { kind: "code"; flow: Flow; email: string }
  | { kind: "restart"; email: string };

const INCOMPLETE_SIGN_UP =
  "Sign-up needs details the app does not collect. Check the Clerk settings.";

export default function SignInScreen() {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against a second press that lands before the disabled state renders.
  const inFlight = useRef(false);
  // Set once the current attempt's code has verified, so a retry after a
  // failed finalize finalizes again and never re-submits the code. Cleared
  // when a new code is sent for a new attempt.
  const verified = useRef(false);

  // Runs one request at a time; a press while one runs does nothing.
  async function run(action: () => Promise<void>) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (thrown) {
      setError(clerkMessage(thrown));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      const address = email.trim();
      if (address === "") {
        setError("Enter your email address.");
        return;
      }
      const sent = await signIn.emailCode.sendCode({ emailAddress: address });
      if (sent.error === null) {
        enterCode("signIn", address);
        return;
      }
      if (!hasClerkCode(sent.error, IDENTIFIER_NOT_FOUND)) {
        setError(clerkMessage(sent.error));
        return;
      }
      // No Clerk user holds this address, so this is a first sign-in.
      await startSignUp(address);
    });

  // Shows the code step for a new attempt.
  function enterCode(flow: Flow, address: string) {
    verified.current = false;
    setCode("");
    setStep({ kind: "code", flow, email: address });
  }

  // Creates a new Clerk sign-up for the address and emails its code. Any
  // earlier sign-up is abandoned.
  async function startSignUp(address: string) {
    const created = await signUp.create({ emailAddress: address });
    if (created.error !== null) {
      setError(clerkMessage(created.error));
      return;
    }
    const sent = await signUp.verifications.sendEmailCode();
    if (sent.error !== null) {
      setError(clerkMessage(sent.error));
      return;
    }
    enterCode("signUp", address);
  }

  const restartSignUp = (address: string) => run(() => startSignUp(address));

  const resendCode = (flow: Flow) =>
    run(async () => {
      const sent =
        flow === "signIn"
          ? await signIn.emailCode.sendCode()
          : await signUp.verifications.sendEmailCode();
      if (sent.error !== null) {
        setError(clerkMessage(sent.error));
        return;
      }
      setCode("");
    });

  const verifyCode = (flow: Flow, address: string) =>
    run(async () => {
      if (!verified.current) {
        const entered = code.trim();
        if (entered === "") {
          setError("Enter the code from the email.");
          return;
        }
        const result =
          flow === "signIn"
            ? await signIn.emailCode.verifyCode({ code: entered })
            : await signUp.verifications.verifyEmailCode({ code: entered });
        if (result.error !== null) {
          setError(codeMessage(result.error));
          return;
        }
        verified.current = true;
      }
      if (flow === "signIn") {
        if (signIn.status !== "complete") {
          setError("This account needs a sign-in step the app does not support.");
          return;
        }
        const finalized = await signIn.finalize();
        if (finalized.error !== null) {
          setError(clerkMessage(finalized.error));
        }
        return;
      }
      if (signUp.status !== "complete") {
        // The verified sign-up cannot finish, and verifying it again fails, so
        // only a new sign-up can go on.
        setCode("");
        setStep({ kind: "restart", email: address });
        return;
      }
      const finalized = await signUp.finalize();
      if (finalized.error !== null) {
        setError(clerkMessage(finalized.error));
      }
    });

  const changeEmail = () => {
    verified.current = false;
    setStep({ kind: "email" });
    setCode("");
    setError(null);
  };

  return (
    <HeaderlessScreen style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        Sign in to AgentDesk
      </Text>
      {step.kind === "email" ? (
        <>
          <Text style={styles.body}>We email you a code. There is no password.</Text>
          <TextInput
            accessibilityLabel="Email address"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            editable={!busy}
            inputMode="email"
            onChangeText={setEmail}
            onSubmitEditing={sendCode}
            placeholder="you@example.com"
            style={styles.input}
            value={email}
          />
          {error !== null && <Text style={styles.error}>{error}</Text>}
          <Button label="Send code" onPress={sendCode} disabled={busy} />
        </>
      ) : step.kind === "restart" ? (
        <>
          <Text style={styles.body}>Signing up {step.email} did not finish.</Text>
          <Text style={styles.error}>{INCOMPLETE_SIGN_UP}</Text>
          {error !== null && <Text style={styles.error}>{error}</Text>}
          <Button
            label="Start sign-up again"
            onPress={() => restartSignUp(step.email)}
            disabled={busy}
          />
          <Pressable accessibilityRole="button" disabled={busy} onPress={changeEmail}>
            <Text style={styles.link}>Use a different email</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.body}>Enter the code we sent to {step.email}.</Text>
          <TextInput
            accessibilityLabel="Code"
            autoComplete="one-time-code"
            editable={!busy}
            inputMode="numeric"
            onChangeText={setCode}
            onSubmitEditing={() => verifyCode(step.flow, step.email)}
            style={styles.input}
            textContentType="oneTimeCode"
            value={code}
          />
          {error !== null && <Text style={styles.error}>{error}</Text>}
          <Button
            label="Verify"
            onPress={() => verifyCode(step.flow, step.email)}
            disabled={busy}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => resendCode(step.flow)}
          >
            <Text style={styles.link}>Send a new code</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={changeEmail}>
            <Text style={styles.link}>Use a different email</Text>
          </Pressable>
        </>
      )}
    </HeaderlessScreen>
  );
}
