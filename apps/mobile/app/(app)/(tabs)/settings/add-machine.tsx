import { useMutation } from "convex/react";
import { Stack, useRouter } from "expo-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, AppState, useWindowDimensions, View } from "react-native";
import { identity } from "../../../../../../convex/identity/refs";
import {
  CODE_LENGTH,
  checkLookup,
  checkOutcome,
  cleanCodeInput,
  type FoundRequest,
  harnessNames,
  LOCK_WINDOW_MS,
  normalizeCode,
  type Refusal,
} from "../../../../src/add-machine";
import { Button } from "../../../../src/button";
import { haptic } from "../../../../src/haptics";
import { makeStyles, spacing, useTheme } from "../../../../src/theme";
import { Card } from "../../../../src/ui/card";
import { CodeInput } from "../../../../src/ui/code-input";
import { Dock } from "../../../../src/ui/dock";
import { EmptyState } from "../../../../src/ui/empty-state";
import { Icon } from "../../../../src/ui/icon";
import { StackScreen } from "../../../../src/ui/screen";
import { AppText } from "../../../../src/ui/text";

// component-mobile-app §Screens: the person enters the installer's code, sees
// the requesting machine and its harnesses, and approves or declines
// (req-accounts-and-connections AC-6.2, AC-6.5, AC-6.6). Lookup records a
// wrong-code attempt on the backend, so only a press of Find machine sends
// it; filling the last box does not, so a typo can still be fixed for free.

const ENTRY_GUIDANCE = "Enter the code shown by the installer";
const FOUND_NOTE = "Each harness gets its own connection, which you can revoke separately.";
const NOT_FOUND = "That code is wrong or no longer available. Check the code and try again.";
const EXPIRED = "That code expired. Run the installer again for a new code.";
const LOCKED = "Too many wrong codes. Try again in 10 minutes.";
const APPROVED = "The machine is connecting. The installer will finish on its own.";
const DECLINED = "Request declined. Run the installer again for a new code.";

type Operation = "lookup" | "approve" | "decline";

const FAILURES: Record<Operation, string> = {
  lookup: "Could not find the machine. Check your connection and try again.",
  approve: "Could not approve the request. Check your connection and try again.",
  decline: "Could not decline the request. Check your connection and try again.",
};

type Call = (args: { code: string }) => Promise<unknown>;

type Phase =
  | { kind: "entry" }
  | { kind: "found"; code: string; request: FoundRequest }
  | { kind: "approved" }
  | { kind: "declined" };

// A failed call and the code it sent, so Try again repeats that call.
type Failure = { operation: Operation; code: string };

// Apple HIG Playing haptics and VoiceOver: a refused code or a failed call
// plays the error haptic and is read out, since the message appears away from
// the focused control.
function reportError(message: string) {
  haptic.error();
  AccessibilityInfo.announceForAccessibility(message);
}

const useStyles = makeStyles((theme) => ({
  entry: { alignItems: "center", gap: 14, paddingHorizontal: 24, paddingTop: 22 },
  center: { textAlign: "center" },
  actions: { gap: 12, paddingHorizontal: spacing.screen, paddingTop: 22 },
  card: { gap: 12, marginTop: 26, padding: 18 },
  machine: { alignItems: "center", flexDirection: "row", gap: 10 },
  machineTile: {
    alignItems: "center",
    backgroundColor: theme.green,
    borderRadius: 10,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  harnesses: {
    backgroundColor: theme.scheme === "dark" ? theme.cardRaised : theme.background,
    borderRadius: 10,
    overflow: "hidden",
  },
  harness: { alignItems: "center", flexDirection: "row", gap: 10, padding: 12 },
  separator: { backgroundColor: theme.separator, height: 0.5, marginLeft: 12 },
  dockRow: { flexDirection: "row", gap: 10 },
  dockStack: { gap: 10 },
}));

// Calls `release` once the local lock window ends. The timer reads the clock
// again when the app returns to the foreground, because a suspended app runs
// no timers. Nothing is sent when the window ends.
function useLockRelease(until: number | null, release: () => void) {
  useEffect(() => {
    if (until === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const left = until - Date.now();
      if (left <= 0) {
        release();
        return;
      }
      timer = setTimeout(check, left);
    };
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        check();
      }
    });
    return () => {
      subscription.remove();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [until, release]);
}

// An error line with a Try again button that repeats the failed call.
function Retry({
  message,
  onRetry,
  disabled,
}: {
  message: string;
  onRetry: () => void;
  disabled: boolean;
}) {
  return (
    <>
      <AppText variant="subhead" tone="red">
        {message}
      </AppText>
      <Button label="Try again" variant="secondary" onPress={onRetry} disabled={disabled} />
    </>
  );
}

// The requesting machine and the harnesses it would connect.
function RequestCard({ request }: { request: FoundRequest }) {
  const styles = useStyles();
  return (
    <Card style={styles.card}>
      <View style={styles.machine}>
        <View style={styles.machineTile}>
          <Icon name="server" size={22} color="#ffffff" />
        </View>
        <View>
          <AppText variant="headline">{request.machineName}</AppText>
          <AppText variant="subhead" tone="secondary">
            wants to connect
          </AppText>
        </View>
      </View>
      <View accessibilityLabel="Harnesses" style={styles.harnesses}>
        {harnessNames(request).map((name, index) => (
          <View key={name}>
            {index === 0 ? null : <View style={styles.separator} />}
            <HarnessLine name={name} />
          </View>
        ))}
      </View>
      <AppText variant="footnote" tone="secondary">
        {FOUND_NOTE}
      </AppText>
    </Card>
  );
}

function HarnessLine({ name }: { name: string }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.harness}>
      <Icon name="checkmark" size={17} color={theme.green} />
      <AppText>{name}</AppText>
    </View>
  );
}

// The found request with its actions: the card in the scrolling body and
// Decline and Approve in the dock. It owns the approve and decline hooks, so
// the screen binds them only once a request is found.
function FoundRequestScreen({
  code,
  request,
  field,
  busy,
  failure,
  run,
  onUseAnotherCode,
}: {
  code: string;
  request: FoundRequest;
  field: ReactNode;
  busy: Operation | null;
  failure: Failure | null;
  run: (operation: Operation, code: string, call: Call) => void;
  onUseAnotherCode: () => void;
}) {
  const styles = useStyles();
  // Apple HIG Typography: at large Dynamic Type sizes the pair stacks, so
  // neither label is cut short.
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.35;
  const approve = useMutation(identity.deviceRequests.approveDeviceRequest);
  const decline = useMutation(identity.deviceRequests.declineDeviceRequest);
  const calls: Record<"approve" | "decline", Call> = { approve, decline };
  const disabled = busy !== null;
  const retry =
    failure !== null && failure.operation !== "lookup"
      ? { operation: failure.operation, code: failure.code }
      : null;
  return (
    <>
      <StackScreen>
        {field}
        <RequestCard request={request} />
        <View style={styles.actions}>
          {retry === null ? null : (
            <Retry
              message={FAILURES[retry.operation]}
              onRetry={() => run(retry.operation, retry.code, calls[retry.operation])}
              disabled={disabled}
            />
          )}
          <Button
            label="Use another code"
            variant="plain"
            onPress={onUseAnotherCode}
            disabled={disabled}
          />
        </View>
      </StackScreen>
      <Dock>
        <View style={stacked ? styles.dockStack : styles.dockRow}>
          <Button
            label={busy === "decline" ? "Declining..." : "Decline"}
            variant="destructive"
            grow={!stacked}
            onPress={() => run("decline", code, decline)}
            disabled={disabled}
          />
          <Button
            label={busy === "approve" ? "Approving..." : "Approve"}
            grow={!stacked}
            onPress={() => run("approve", code, approve)}
            disabled={disabled}
          />
        </View>
      </Dock>
    </>
  );
}

// The settled request: a confirmation with Done, which returns to the
// connections list, and a way to enter another code.
function Outcome({ approved, onEnterAnother }: { approved: boolean; onEnterAnother: () => void }) {
  const router = useRouter();
  return (
    <StackScreen>
      <EmptyState
        icon={approved ? "checkmark-circle" : "close-circle"}
        title={approved ? "Machine approved" : "Request declined"}
        body={approved ? APPROVED : DECLINED}
      >
        <Button label="Done" onPress={() => router.dismissTo("/settings/connections")} />
        <Button label="Enter another code" variant="plain" onPress={onEnterAnother} />
      </EmptyState>
    </StackScreen>
  );
}

export default function AddMachineScreen() {
  const styles = useStyles();
  const lookup = useMutation(identity.deviceRequests.lookupDeviceRequest);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "entry" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  // Set synchronously, so a second press before the re-render sends nothing.
  const pending = useRef(false);
  // Cleared on unmount, so a call that settles later changes nothing.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const releaseLock = useCallback(() => setLockedUntil(null), []);
  useLockRelease(lockedUntil, releaseLock);

  const locked = lockedUntil !== null;
  const code = normalizeCode(input);

  const refuse = (refusal: Refusal) => {
    setPhase({ kind: "entry" });
    if (refusal.status === "locked") {
      setNotice(null);
      setLockedUntil(Date.now() + LOCK_WINDOW_MS);
      reportError(LOCKED);
    } else {
      const message = refusal.status === "expired" ? EXPIRED : NOT_FOUND;
      setNotice(message);
      reportError(message);
    }
  };

  const settle = (operation: Operation, sent: string, value: unknown) => {
    if (operation === "lookup") {
      const result = checkLookup(value);
      if (result === null) {
        return false;
      }
      if (result.status === "found") {
        setPhase({ kind: "found", code: sent, request: result });
      } else {
        refuse(result);
      }
      return true;
    }
    const success = operation === "approve" ? "approved" : "declined";
    const result = checkOutcome(value, success);
    if (result === null) {
      return false;
    }
    if (result.status === "approved") {
      setPhase({ kind: "approved" });
      haptic.success();
      AccessibilityInfo.announceForAccessibility("Machine approved");
    } else if (result.status === "declined") {
      // The installer can ask again with a new code, so a decline needs no
      // confirmation and no success haptic; VoiceOver still hears it.
      setPhase({ kind: "declined" });
      AccessibilityInfo.announceForAccessibility("Request declined");
    } else {
      refuse(result);
    }
    return true;
  };

  const run = async (operation: Operation, sent: string, call: Call) => {
    if (pending.current || locked) {
      return;
    }
    pending.current = true;
    setBusy(operation);
    setFailure(null);
    setNotice(null);
    let value: unknown;
    let rejected = false;
    try {
      value = await call({ code: sent });
    } catch {
      rejected = true;
    }
    pending.current = false;
    if (!mounted.current) {
      return;
    }
    setBusy(null);
    if (rejected) {
      setFailure({ operation, code: sent });
      reportError(FAILURES[operation]);
    } else if (!settle(operation, sent, value)) {
      console.warn(`Unexpected ${operation} response from identity/deviceRequests`, value);
      setFailure({ operation, code: sent });
      reportError(FAILURES[operation]);
    }
  };

  const start = (operation: Operation, sent: string, call: Call) => {
    void run(operation, sent, call);
  };

  const reset = () => {
    setPhase({ kind: "entry" });
    setInput("");
    setNotice(null);
    setFailure(null);
  };

  const edit = (text: string) => {
    setInput(cleanCodeInput(text));
    setNotice(null);
    setFailure(null);
  };

  const title = <Stack.Screen options={{ title: "Add machine" }} />;

  if (phase.kind === "approved" || phase.kind === "declined") {
    return (
      <>
        {title}
        <Outcome approved={phase.kind === "approved"} onEnterAnother={reset} />
      </>
    );
  }

  // While locked, the lock message takes the guidance's place.
  const field = (
    <View style={styles.entry}>
      {locked ? (
        <AppText variant="subhead" tone="red" style={styles.center}>
          {LOCKED}
        </AppText>
      ) : (
        <AppText variant="subhead" tone="secondary" style={styles.center}>
          {ENTRY_GUIDANCE}
        </AppText>
      )}
      <CodeInput
        accessibilityLabel="Installer code"
        length={CODE_LENGTH}
        groups={[4, 4]}
        autoCapitalize="characters"
        autoComplete="off"
        autoFocus={phase.kind === "entry"}
        editable={phase.kind === "entry" && busy === null && !locked}
        onChangeText={edit}
        value={input}
      />
    </View>
  );

  if (phase.kind === "found") {
    return (
      <>
        {title}
        <FoundRequestScreen
          code={phase.code}
          request={phase.request}
          field={field}
          busy={busy}
          failure={failure}
          run={start}
          onUseAnotherCode={reset}
        />
      </>
    );
  }

  const lookupFailure = failure?.operation === "lookup" ? failure : null;
  return (
    <>
      {title}
      <StackScreen>
        {field}
        <View style={styles.actions}>
          {notice === null || locked ? null : (
            <AppText variant="subhead" tone="red" style={styles.center}>
              {notice}
            </AppText>
          )}
          {lookupFailure === null ? null : (
            <Retry
              message={FAILURES.lookup}
              onRetry={() => start("lookup", lookupFailure.code, lookup)}
              disabled={busy !== null || locked}
            />
          )}
          <Button
            label={busy === "lookup" ? "Finding machine..." : "Find machine"}
            onPress={() => {
              if (code !== null) {
                start("lookup", code, lookup);
              }
            }}
            disabled={code === null || busy !== null || locked}
          />
        </View>
      </StackScreen>
    </>
  );
}
