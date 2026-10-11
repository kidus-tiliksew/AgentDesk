import { useSignIn, useSignUp } from "@clerk/expo";
import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Button } from "../../src/button";
import {
  clerkMessage,
  codeMessage,
  hasClerkCode,
  IDENTIFIER_NOT_FOUND,
} from "../../src/clerk-errors";
import { styles } from "../../src/styles";

// component-mobile-app §Screens `(auth)/sign-in`: an email address, then the
// code Clerk emails to it, with no password (req-accounts-and-connections
// REQ-2). An address that holds no Clerk user signs up through the same two
// steps. Finalizing activates the Clerk session; the (auth) layout then
// redirects to the app, whose layout creates the account.

type Flow = "signIn" | "signUp";
type Step = { kind: "email" } | { kind: "code"; flow: Flow; email: string };

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
        setCode("");
        setStep({ kind: "code", flow: "signIn", email: address });
        return;
      }
      if (!hasClerkCode(sent.error, IDENTIFIER_NOT_FOUND)) {
        setError(clerkMessage(sent.error));
        return;
      }
      // No Clerk user holds this address, so this is a first sign-in.
      const created = await signUp.create({ emailAddress: address });
      if (created.error !== null) {
        setError(clerkMessage(created.error));
        return;
      }
      const sentUp = await signUp.verifications.sendEmailCode();
      if (sentUp.error !== null) {
        setError(clerkMessage(sentUp.error));
        return;
      }
      setCode("");
      setStep({ kind: "code", flow: "signUp", email: address });
    });

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

  const verifyCode = (flow: Flow) =>
    run(async () => {
      const entered = code.trim();
      if (entered === "") {
        setError("Enter the code from the email.");
        return;
      }
      if (flow === "signIn") {
        const verified = await signIn.emailCode.verifyCode({ code: entered });
        if (verified.error !== null) {
          setError(codeMessage(verified.error));
          return;
        }
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
      const verified = await signUp.verifications.verifyEmailCode({ code: entered });
      if (verified.error !== null) {
        setError(codeMessage(verified.error));
        return;
      }
      if (signUp.status !== "complete") {
        setError("Sign-up needs details the app does not collect. Check the Clerk settings.");
        return;
      }
      const finalized = await signUp.finalize();
      if (finalized.error !== null) {
        setError(clerkMessage(finalized.error));
      }
    });

  const changeEmail = () => {
    setStep({ kind: "email" });
    setCode("");
    setError(null);
  };

  return (
    <View style={styles.screen}>
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
      ) : (
        <>
          <Text style={styles.body}>Enter the code we sent to {step.email}.</Text>
          <TextInput
            accessibilityLabel="Code"
            autoComplete="one-time-code"
            editable={!busy}
            inputMode="numeric"
            onChangeText={setCode}
            onSubmitEditing={() => verifyCode(step.flow)}
            style={styles.input}
            textContentType="oneTimeCode"
            value={code}
          />
          {error !== null && <Text style={styles.error}>{error}</Text>}
          <Button label="Verify" onPress={() => verifyCode(step.flow)} disabled={busy} />
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
    </View>
  );
}
