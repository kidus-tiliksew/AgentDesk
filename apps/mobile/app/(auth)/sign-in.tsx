import { useSignIn, useSignUp } from "@clerk/expo";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { deletionNoticeText, useDeletionNotice } from "../../src/account-deletion";
import { Button } from "../../src/button";
import {
  clerkMessage,
  codeMessage,
  hasClerkCode,
  IDENTIFIER_NOT_FOUND,
} from "../../src/clerk-errors";
import { PRIVACY_POLICY_URL } from "../../src/config";
import { haptic } from "../../src/haptics";
import { HeaderlessScreen } from "../../src/headerless-screen";
import { formatCooldown, useResendCooldown } from "../../src/sign-in-cooldown";
import { makeStyles, radius, useTheme } from "../../src/theme";
import { CodeInput } from "../../src/ui/code-input";
import { AppText } from "../../src/ui/text";

// component-mobile-app §Screens `(auth)/sign-in`: an email address, then the
// code Clerk emails to it, with no password (req-accounts-and-connections
// REQ-2). An address that holds no Clerk user signs up through the same two
// steps. Finalizing activates the Clerk session; the (auth) layout then
// redirects to the app, whose layout creates the account. A sign-up whose
// code verified but that Clerk still holds incomplete cannot go on, so the
// screen offers a fresh sign-up for the same address instead of the code step.
// Design "Sign in: email" and "Sign in: code": the app mark over a centered
// form, then six code boxes that submit on the last digit. After this device
// deleted an account, the email step says the account is being deleted and
// when its data will be gone (component-mobile-app §Account deletion). A
// Privacy Policy link below the form, on every step, opens the website's
// privacy policy in an in-app browser sheet (req-mobile-app AC-7.2).

type Flow = "signIn" | "signUp";
type Step =
  | { kind: "email" }
  | { kind: "code"; flow: Flow; email: string }
  | { kind: "restart"; email: string };

// Clerk's email codes are six digits.
const CODE_LENGTH = 6;

const INCOMPLETE_SIGN_UP =
  "Sign-up needs details the app does not collect. Check the Clerk settings.";

const logo = require("../../assets/logo.png");

const useStyles = makeStyles((theme) => ({
  keyboard: { flex: 1 },
  screen: { flex: 1, justifyContent: "center" },
  brand: { alignItems: "center", gap: 6 },
  logo: { borderRadius: 17, height: 76, marginBottom: 14, width: 76 },
  center: { textAlign: "center" },
  form: { gap: 12, marginTop: 40 },
  input: {
    backgroundColor: theme.card,
    borderRadius: radius.control,
    color: theme.text,
    fontSize: 17,
    // Apple HIG Typography: the field grows with Dynamic Type.
    minHeight: 50,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sentTo: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  codeForm: { gap: 16, marginTop: 34 },
  privacy: { alignSelf: "center", marginTop: 28 },
}));

function Brand() {
  const styles = useStyles();
  return (
    <View style={styles.brand}>
      <Image accessibilityIgnoresInvertColors source={logo} style={styles.logo} />
      <AppText accessibilityRole="header" variant="title1">
        AgentDesk
      </AppText>
      <AppText variant="callout" tone="secondary" style={styles.center}>
        Answer your coding agents from anywhere.
      </AppText>
    </View>
  );
}

function ErrorText({ error }: { error: string | null }) {
  const styles = useStyles();
  if (error === null) {
    return null;
  }
  return (
    <AppText variant="subhead" tone="red" style={styles.center}>
      {error}
    </AppText>
  );
}

export default function SignInScreen() {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const styles = useStyles();
  const theme = useTheme();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cooldown = useResendCooldown();
  const notice = useDeletionNotice();
  // Guards against a second press that lands before the disabled state renders.
  const inFlight = useRef(false);
  // Set once the current attempt's code has verified, so a retry after a
  // failed finalize finalizes again and never re-submits the code. Cleared
  // when a new code is sent for a new attempt.
  const verified = useRef(false);

  // Apple HIG VoiceOver: an error is spoken when it appears, since focus stays
  // on the control that caused it.
  useEffect(() => {
    if (error !== null) {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);

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
    cooldown.start();
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
      cooldown.start();
    });

  // `typed` is the code as the last box filled, which the state does not hold
  // yet when the boxes submit on their own.
  const verifyCode = (flow: Flow, address: string, typed: string = code) =>
    run(async () => {
      if (!verified.current) {
        const entered = typed.trim();
        if (entered === "") {
          setError("Enter the code from the email.");
          return;
        }
        const result =
          flow === "signIn"
            ? await signIn.emailCode.verifyCode({ code: entered })
            : await signUp.verifications.verifyEmailCode({ code: entered });
        if (result.error !== null) {
          // Apple HIG Playing haptics: a rejected code is felt as an error.
          haptic.error();
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
        signedIn(await signIn.finalize());
        return;
      }
      if (signUp.status !== "complete") {
        // The verified sign-up cannot finish, and verifying it again fails, so
        // only a new sign-up can go on.
        setCode("");
        setStep({ kind: "restart", email: address });
        haptic.error();
        AccessibilityInfo.announceForAccessibility(INCOMPLETE_SIGN_UP);
        return;
      }
      signedIn(await signUp.finalize());
    });

  // Apple HIG Playing haptics: the verified code that signs the person in is
  // felt as a success, and a failed finalize as an error.
  function signedIn(finalized: { error: unknown }) {
    if (finalized.error === null) {
      haptic.success();
      return;
    }
    haptic.error();
    setError(clerkMessage(finalized.error));
  }

  const changeEmail = () => {
    verified.current = false;
    setStep({ kind: "email" });
    setCode("");
    setError(null);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.keyboard}
    >
      <HeaderlessScreen style={styles.screen}>
        {step.kind === "email" ? (
          <>
            <Brand />
            <View style={styles.form}>
              {notice === null ? null : (
                <AppText accessibilityRole="alert" variant="subhead" style={styles.center}>
                  {deletionNoticeText(notice.completeBy)}
                </AppText>
              )}
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
                placeholderTextColor={theme.textSecondary}
                returnKeyType="go"
                selectionColor={theme.accent}
                style={styles.input}
                textContentType="emailAddress"
                value={email}
              />
              <ErrorText error={error} />
              <Button label="Continue" onPress={sendCode} disabled={busy} />
              <AppText variant="footnote" tone="secondary" style={styles.center}>
                We'll email you a 6-digit code. No password.
              </AppText>
            </View>
          </>
        ) : step.kind === "restart" ? (
          <>
            <Brand />
            <View style={styles.form}>
              <AppText style={styles.center}>Signing up {step.email} did not finish.</AppText>
              <AppText variant="subhead" tone="red" style={styles.center}>
                {INCOMPLETE_SIGN_UP}
              </AppText>
              <ErrorText error={error} />
              <Button
                label="Start sign-up again"
                onPress={() => restartSignUp(step.email)}
                disabled={busy}
              />
              <Button
                label="Use a different email"
                variant="plain"
                onPress={changeEmail}
                disabled={busy}
              />
            </View>
          </>
        ) : (
          <>
            <View style={styles.brand}>
              <AppText accessibilityRole="header" variant="title1" style={styles.center}>
                Check your email
              </AppText>
              <AppText variant="callout" tone="secondary" style={styles.center}>
                We sent a code to
              </AppText>
              <View style={styles.sentTo}>
                <AppText variant="callout" weight="600">
                  {step.email}
                </AppText>
                <AppText variant="callout" tone="secondary">
                  {" · "}
                </AppText>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Use a different email"
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  // Apple HIG Buttons: the text link's hit region is 44pt.
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  onPress={changeEmail}
                >
                  <AppText variant="callout" tone="accent">
                    Change
                  </AppText>
                </Pressable>
              </View>
            </View>
            <View style={styles.codeForm}>
              <CodeInput
                length={CODE_LENGTH}
                accessibilityLabel="Code"
                autoComplete="one-time-code"
                autoFocus
                editable={!busy}
                inputMode="numeric"
                textContentType="oneTimeCode"
                value={code}
                onChangeText={setCode}
                onComplete={(text) => verifyCode(step.flow, step.email, text)}
              />
              <ErrorText error={error} />
              {/* The boxes submit on the last digit; the number pad has no
                  return key, so Verify is how a person retries the same code,
                  for example after a failed finalize. */}
              <Button
                label="Verify"
                onPress={() => verifyCode(step.flow, step.email)}
                disabled={busy}
              />
              {cooldown.remaining > 0 ? (
                <AppText variant="subhead" tone="secondary" style={styles.center}>
                  {`Resend code in ${formatCooldown(cooldown.remaining)}`}
                </AppText>
              ) : (
                <Button
                  label="Send a new code"
                  variant="plain"
                  onPress={() => resendCode(step.flow)}
                  disabled={busy}
                />
              )}
            </View>
          </>
        )}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Privacy Policy"
          // Apple HIG Buttons: the text link's hit region is 44pt.
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          onPress={() => WebBrowser.openBrowserAsync(PRIVACY_POLICY_URL)}
          style={styles.privacy}
        >
          <AppText variant="subhead" tone="accent">
            Privacy Policy
          </AppText>
        </Pressable>
      </HeaderlessScreen>
    </KeyboardAvoidingView>
  );
}
