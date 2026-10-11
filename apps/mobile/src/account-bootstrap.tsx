import { errorCodeSchema } from "@agentdesk/contract";
import { useAuth } from "@clerk/expo";
import { useConvexAuth, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
// The app references Convex functions through each domain's refs module, not
// convex/_generated/api, so it builds without local codegen. Later screens
// import their domain's refs from ../../../convex/<domain>/refs the same way.
import { identity } from "../../../convex/identity/refs";
import { Button } from "./button";
import { Loading } from "./loading";
import { styles } from "./styles";

type Outcome = "ready" | "refused" | "failed";

function isUnauthenticated(error: unknown) {
  return (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    error.data.code === errorCodeSchema.enum.unauthenticated
  );
}

// Mounts its children only after ensureAccount succeeds for the active Clerk
// session, so the first sign-in creates the account (req-accounts-and-
// connections AC-2.1) before any screen issues another Convex call. Each
// session and retry is one key; a key is requested once however often the
// gate renders, and a completion for a key that is no longer current is
// dropped, so a late result cannot unlock another session's screens.
export function AccountGate({ children }: { children: ReactNode }) {
  const { sessionId, signOut } = useAuth();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const ensureAccount = useMutation(identity.accounts.ensureAccount);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; outcome: Outcome } | null>(null);
  const requested = useRef<string | null>(null);

  const key = sessionId ? `${sessionId}#${attempt}` : null;

  useEffect(() => {
    if (key === null || isLoading || !isAuthenticated || requested.current === key) {
      return;
    }
    requested.current = key;
    ensureAccount({}).then(
      () => {
        if (requested.current === key) {
          setResult({ key, outcome: "ready" });
        }
      },
      (error: unknown) => {
        if (requested.current !== key) {
          return;
        }
        if (isUnauthenticated(error)) {
          // The account is being deleted: end the Clerk session, and the
          // (app) layout returns to sign-in.
          setResult({ key, outcome: "refused" });
          signOut().catch(() => undefined);
          return;
        }
        setResult({ key, outcome: "failed" });
      },
    );
  }, [key, isLoading, isAuthenticated, ensureAccount, signOut]);

  const outcome = result !== null && result.key === key ? result.outcome : null;
  if (outcome === "ready") {
    return children;
  }
  if (outcome === "refused") {
    return <Loading label="Signing out" />;
  }
  if (outcome === "failed") {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>Could not set up your account. Check your connection.</Text>
        <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} />
      </View>
    );
  }
  if (!isLoading && !isAuthenticated) {
    // Clerk holds a session that the backend did not accept.
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>The AgentDesk backend did not accept this sign-in.</Text>
        <Button label="Sign out" onPress={() => signOut().catch(() => undefined)} />
      </View>
    );
  }
  return <Loading label="Setting up your account" />;
}
