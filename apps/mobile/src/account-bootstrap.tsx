import { errorCodeSchema } from "@agentdesk/contract";
import { useAuth } from "@clerk/expo";
import { useConvexAuth, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Text } from "react-native";
// The app references Convex functions through each domain's refs module, not
// convex/_generated/api, so it builds without local codegen. Later screens
// import their domain's refs from ../../../convex/<domain>/refs the same way.
import { identity } from "../../../convex/identity/refs";
import { Button } from "./button";
import { HeaderlessScreen } from "./headerless-screen";
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

// Mounts its children only while Convex reports the Clerk session as
// authenticated and ensureAccount has succeeded for that session, so the first
// sign-in creates the account (req-accounts-and-connections AC-2.1) before any
// screen issues another Convex call. Each session and retry is one key. A key
// is requested once however often the gate renders. `active` names the key
// the committed render shows, and it changes as soon as the session does,
// even while the new session waits for Convex, so a completion for any other
// key is dropped: a late result can neither unlock nor sign out another
// session.
export function AccountGate({ children }: { children: ReactNode }) {
  const { sessionId, signOut } = useAuth();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const ensureAccount = useMutation(identity.accounts.ensureAccount);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; outcome: Outcome } | null>(null);
  const requested = useRef<string | null>(null);
  const active = useRef<string | null>(null);

  const key = sessionId ? `${sessionId}#${attempt}` : null;

  // A layout effect runs at commit, before any pending completion can run.
  useLayoutEffect(() => {
    active.current = key;
  }, [key]);

  useEffect(() => {
    if (!sessionId || key === null || isLoading || !isAuthenticated || requested.current === key) {
      return;
    }
    requested.current = key;
    ensureAccount({}).then(
      () => {
        if (active.current === key) {
          setResult({ key, outcome: "ready" });
        }
      },
      (error: unknown) => {
        if (active.current !== key) {
          return;
        }
        if (isUnauthenticated(error)) {
          // The account is being deleted: end this Clerk session, and the
          // (app) layout returns to sign-in.
          setResult({ key, outcome: "refused" });
          signOut({ sessionId }).catch(() => undefined);
          return;
        }
        setResult({ key, outcome: "failed" });
      },
    );
  }, [sessionId, key, isLoading, isAuthenticated, ensureAccount, signOut]);

  const outcome = result !== null && result.key === key ? result.outcome : null;
  if (outcome === "refused") {
    return <Loading label="Signing out" headerless />;
  }
  if (outcome === "failed") {
    return (
      <HeaderlessScreen style={styles.centered}>
        <Text style={styles.error}>Could not set up your account. Check your connection.</Text>
        <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} />
      </HeaderlessScreen>
    );
  }
  if (isLoading) {
    return (
      <Loading
        label={outcome === "ready" ? "Reconnecting" : "Setting up your account"}
        headerless
      />
    );
  }
  if (!isAuthenticated) {
    // Clerk holds a session that the backend does not accept.
    return (
      <HeaderlessScreen style={styles.centered}>
        <Text style={styles.error}>The AgentDesk backend did not accept this sign-in.</Text>
        <Button label="Sign out" onPress={() => signOut().catch(() => undefined)} />
      </HeaderlessScreen>
    );
  }
  if (outcome === "ready") {
    return children;
  }
  return <Loading label="Setting up your account" headerless />;
}
