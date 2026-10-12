import { useMutation } from "convex/react";
import { Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { identity } from "../../../../../convex/identity/refs";
import {
  checkLookup,
  checkOutcome,
  type FoundRequest,
  harnessNames,
  LOCK_WINDOW_MS,
  normalizeCode,
  type Refusal,
} from "../../../src/add-machine";
import { Button } from "../../../src/button";
import { styles } from "../../../src/styles";

// component-mobile-app §Screens: the person enters the installer's code, sees
// the requesting machine and its harnesses, and approves or declines
// (req-accounts-and-connections AC-6.2, AC-6.5, AC-6.6). Lookup records a
// wrong-code attempt on the backend, so only a press of Find machine sends it.

const ENTRY_GUIDANCE = "Enter the 8-character code shown by the installer.";
const FOUND_GUIDANCE = "Approve to connect these harnesses on this machine.";
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

function Field({ label, values }: { label: string; values: string[] }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {values.map((value) => (
        <Text key={value} style={styles.line}>
          {value}
        </Text>
      ))}
    </View>
  );
}

// The found request with its actions. It owns the approve and decline hooks,
// so the screen binds them only once a request is found.
function FoundRequestActions({
  code,
  request,
  busy,
  failure,
  run,
  onUseAnotherCode,
}: {
  code: string;
  request: FoundRequest;
  busy: Operation | null;
  failure: Failure | null;
  run: (operation: Operation, code: string, call: Call) => void;
  onUseAnotherCode: () => void;
}) {
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
      <Field label="Machine" values={[request.machineName]} />
      <Field label="Harnesses" values={harnessNames(request)} />
      <Text style={styles.line}>{FOUND_GUIDANCE}</Text>
      {retry === null ? null : (
        <>
          <Text style={styles.error}>{FAILURES[retry.operation]}</Text>
          <Button
            label="Try again"
            onPress={() => run(retry.operation, retry.code, calls[retry.operation])}
            disabled={disabled}
          />
        </>
      )}
      <Button
        label={busy === "approve" ? "Approving..." : "Approve"}
        onPress={() => run("approve", code, approve)}
        disabled={disabled}
      />
      <Button
        label={busy === "decline" ? "Declining..." : "Decline"}
        onPress={() => run("decline", code, decline)}
        disabled={disabled}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onUseAnotherCode}
      >
        <Text style={styles.link}>Use another code</Text>
      </Pressable>
    </>
  );
}

export default function AddMachineScreen() {
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
    } else {
      setNotice(refusal.status === "expired" ? EXPIRED : NOT_FOUND);
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
    if (result.status === "approved" || result.status === "declined") {
      setPhase({ kind: result.status });
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
    } else if (!settle(operation, sent, value)) {
      console.warn(`Unexpected ${operation} response from identity/deviceRequests`, value);
      setFailure({ operation, code: sent });
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
    setInput(text);
    setNotice(null);
    setFailure(null);
  };

  const outcome =
    phase.kind === "approved" ? APPROVED : phase.kind === "declined" ? DECLINED : null;
  const lookupFailure = failure?.operation === "lookup" ? failure : null;

  return (
    <>
      <Stack.Screen options={{ title: "Add machine" }} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {outcome !== null ? (
          <>
            <Text style={styles.line}>{outcome}</Text>
            <Pressable accessibilityRole="button" onPress={reset}>
              <Text style={styles.link}>Enter another code</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Installer code</Text>
              <TextInput
                accessibilityLabel="Installer code"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect={false}
                editable={phase.kind === "entry" && busy === null && !locked}
                onChangeText={edit}
                placeholder="ABCD-EFGH"
                style={styles.input}
                value={input}
              />
            </View>
            {phase.kind === "found" ? (
              <FoundRequestActions
                code={phase.code}
                request={phase.request}
                busy={busy}
                failure={failure}
                run={start}
                onUseAnotherCode={reset}
              />
            ) : (
              <>
                {locked ? (
                  <Text style={styles.error}>{LOCKED}</Text>
                ) : (
                  <Text style={styles.line}>{ENTRY_GUIDANCE}</Text>
                )}
                {notice === null || locked ? null : <Text style={styles.error}>{notice}</Text>}
                {lookupFailure === null ? null : (
                  <>
                    <Text style={styles.error}>{FAILURES.lookup}</Text>
                    <Button
                      label="Try again"
                      onPress={() => start("lookup", lookupFailure.code, lookup)}
                      disabled={busy !== null || locked}
                    />
                  </>
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
              </>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}
