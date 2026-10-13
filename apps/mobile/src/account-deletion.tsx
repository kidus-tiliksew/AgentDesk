import { useAuth } from "@clerk/expo";
import { ConvexHttpClient } from "convex/browser";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import { identity } from "../../../convex/identity/refs";
import { Button } from "./button";
import { readConfig } from "./config";
import { HeaderlessScreen } from "./headerless-screen";
import { useStopForDeletion } from "./notifications";
import { styles } from "./styles";
import { AppText } from "./ui/text";

// component-mobile-app §Account deletion (req-accounts-and-connections
// REQ-5, AC-5.1). The deletion runs here, above the route guards, rather
// than in the Account screen, so its outcome survives the screen leaving:
// the account gate can take the routes down before the sign-out finishes.
// One deletion runs at a time, for the Clerk session captured when the
// person confirmed it.
//
// The steps: stop this device's registration and let one already sent
// settle; check that the captured session is still the active one and take
// that session's own token; call `identity/accountDeletion:deleteAccount`
// through a Convex HTTP client authenticated with that token, so the call
// can neither run nor be replayed under another session; then end the
// captured Clerk session. The sign-in screen then says the account is being
// deleted and by when. A failed call keeps the session signed in with a
// retry. Once the deletion has committed, a screen above every route says
// so until the sign-out succeeds, and its Try Again retries only the
// sign-out, never another deletion.

export const DELETE_FAILED = "Could not delete your account. Check your connection and try again.";
export const SIGN_OUT_FAILED =
  "Your account is being deleted, but this device could not sign out. Try again.";

// `running`: the deletion or its sign-out is in progress. `failed`: a step
// failed, and `retry` repeats it.
export type DeletionStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "failed"; message: string };

// What the sign-in screen shows after a deletion: when the purge will have
// finished, in epoch milliseconds.
export type DeletionNotice = { completeBy: number };

type Run = {
  session: string;
  // Set once the backend has committed the deletion.
  completeBy: number | null;
  status: DeletionStatus;
};

type DeletionContext = {
  run: Run | null;
  notice: DeletionNotice | null;
  start: (session: string) => void;
};

const Context = createContext<DeletionContext | null>(null);

function useDeletionContext(): DeletionContext {
  const value = useContext(Context);
  if (value === null) {
    throw new Error("AccountDeletionProvider is missing");
  }
  return value;
}

function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}

// The deadline in the device's locale, for example "Oct 14, 2026, 3:00 PM".
function formatDeadline(completeBy: number): string {
  return new Date(completeBy).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Thrown when the session that confirmed the deletion is no longer the
// active one, or its token belongs to another session. Nothing was sent.
class SessionChanged extends Error {}

// The `sid` claim of a Clerk session token: the session it was issued for.
// Only the payload is read; the backend verifies the signature.
export function tokenSession(token: string): string | null {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const claims: unknown = JSON.parse(atob(padded));
    return typeof claims === "object" &&
      claims !== null &&
      "sid" in claims &&
      typeof claims.sid === "string"
      ? claims.sid
      : null;
  } catch {
    return null;
  }
}

// Mounted at the root inside NotificationProvider, so it outlives both route
// groups.
export function AccountDeletionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { sessionId, signOut } = auth;
  const stopForDeletion = useStopForDeletion();
  const [run, setRun] = useState<Run | null>(null);
  const [notice, setNotice] = useState<(DeletionNotice & { session: string }) | null>(null);
  // The run in progress, set before any call, so a second press while one
  // runs does nothing.
  const inFlight = useRef<string | null>(null);
  // The committed deletion of each session, so a retry only signs out.
  const committed = useRef(new Map<string, number>());
  // The latest Clerk session and auth helpers, read when a queued step runs.
  const current = useRef(sessionId);
  current.current = sessionId;
  const latestAuth = useRef(auth);
  latestAuth.current = auth;

  // A notice belongs to the session that was deleted. Another session
  // signing in clears it.
  useEffect(() => {
    if (sessionId && notice !== null && notice.session !== sessionId) {
      setNotice(null);
    }
  }, [sessionId, notice]);

  // The destructive call, bound to `session`. It runs only while `session`
  // is the active Clerk session, with a token whose `sid` names `session`,
  // through a client that carries only that token. The same token fetch
  // ConvexProviderWithClerk uses selects the Convex integration's token or
  // the `convex` template.
  const deleteAs = useCallback(async (session: string) => {
    if (current.current !== session) {
      throw new SessionChanged();
    }
    const { getToken, sessionClaims } = latestAuth.current;
    const token =
      sessionClaims?.aud === "convex"
        ? await getToken({ skipCache: true })
        : await getToken({ template: "convex", skipCache: true });
    if (current.current !== session || token === null || tokenSession(token) !== session) {
      throw new SessionChanged();
    }
    const config = readConfig();
    if (!config.ok) {
      throw new Error("The app is not configured");
    }
    const client = new ConvexHttpClient(config.config.convexUrl);
    client.setAuth(token);
    return await client.mutation(identity.accountDeletion.deleteAccount, {});
  }, []);

  const start = useCallback(
    (session: string) => {
      if (inFlight.current !== null) {
        return;
      }
      inFlight.current = session;
      const update = (status: DeletionStatus, completeBy: number | null) =>
        setRun({ session, completeBy, status });
      const fail = (message: string, completeBy: number | null) => {
        update({ kind: "failed", message }, completeBy);
        announce(message);
      };
      update({ kind: "running" }, committed.current.get(session) ?? null);
      void (async () => {
        try {
          let completeBy = committed.current.get(session);
          if (completeBy === undefined) {
            try {
              const result = await stopForDeletion(session, () => deleteAs(session));
              completeBy = result.completeBy;
              committed.current.set(session, completeBy);
            } catch (error) {
              if (error instanceof SessionChanged && current.current !== session) {
                // Another session is active now. Its screens show no trace
                // of a deletion that never ran.
                setRun(null);
                return;
              }
              fail(DELETE_FAILED, null);
              return;
            }
            update({ kind: "running" }, completeBy);
          }
          try {
            // Ends only the captured session, so a late completion never
            // signs out a session that started since.
            await signOut({ sessionId: session });
          } catch {
            fail(SIGN_OUT_FAILED, completeBy);
            return;
          }
          committed.current.delete(session);
          setRun(null);
          // The notice is for the sign-in screen this session returns to.
          // When another session is already signed in, it has no place.
          const now = current.current;
          if (!now || now === session) {
            setNotice({ session, completeBy });
          }
        } finally {
          inFlight.current = null;
        }
      })();
    },
    [deleteAs, signOut, stopForDeletion],
  );

  const value = useMemo(
    () => ({
      run,
      notice: notice === null ? null : { completeBy: notice.completeBy },
      start,
    }),
    [run, notice, start],
  );
  // After the backend committed the deletion, the account can do nothing
  // more, so a screen above every route holds the session until its
  // sign-out succeeds, whether or not the account gate still shows the
  // routes.
  const pending = run !== null && run.completeBy !== null && run.session === sessionId ? run : null;
  return (
    <Context.Provider value={value}>
      {children}
      {pending === null || pending.completeBy === null ? null : (
        <DeletionPending
          completeBy={pending.completeBy}
          status={pending.status}
          retry={() => start(pending.session)}
        />
      )}
    </Context.Provider>
  );
}

// The committed deletion's own screen: the deadline, the sign-out in
// progress or its failure, and Try Again, which only signs out.
function DeletionPending({
  completeBy,
  status,
  retry,
}: {
  completeBy: number;
  status: DeletionStatus;
  retry: () => void;
}) {
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <HeaderlessScreen style={[styles.centered, local.screen]}>
        <AppText accessibilityRole="header" variant="title2">
          Deleting your account
        </AppText>
        <AppText style={local.center}>
          {`Your data is removed by ${formatDeadline(completeBy)}.`}
        </AppText>
        {status.kind === "failed" ? (
          <>
            <AppText tone="red" style={local.center}>
              {status.message}
            </AppText>
            <Button label="Try Again" onPress={retry} />
          </>
        ) : (
          <AppText tone="secondary">Signing out</AppText>
        )}
      </HeaderlessScreen>
    </View>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1, gap: 12 },
  center: { textAlign: "center" },
});

// The Account screen's view of the deletion for its own session: the
// status, whether the deletion has committed, and `start` to begin or
// retry. A run for another session shows as idle.
export function useAccountDeletion(session: string | null | undefined): {
  status: DeletionStatus;
  committed: boolean;
  start: () => void;
} {
  const { run, start } = useDeletionContext();
  const own = session && run !== null && run.session === session ? run : null;
  return {
    status: own === null ? { kind: "idle" } : own.status,
    committed: own !== null && own.completeBy !== null,
    start: () => {
      if (session) {
        start(session);
      }
    },
  };
}

// The notice's text, with the deadline in the device's locale.
export function deletionNoticeText(completeBy: number): string {
  return `Your account is being deleted. Its data will be removed by ${formatDeadline(completeBy)}.`;
}

// The sign-in screen's notice after this device deleted an account.
export function useDeletionNotice(): DeletionNotice | null {
  return useDeletionContext().notice;
}
