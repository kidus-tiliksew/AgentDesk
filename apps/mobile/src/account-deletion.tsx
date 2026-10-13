import { useAuth } from "@clerk/expo";
import { useMutation } from "convex/react";
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
import { AccessibilityInfo } from "react-native";
import { identity } from "../../../convex/identity/refs";
import { useStopForDeletion } from "./notifications";

// component-mobile-app §Account deletion (req-accounts-and-connections
// REQ-5, AC-5.1). The deletion runs here, above the route guards, rather
// than in the Account screen, so its outcome survives the screen leaving:
// once the backend deletes the account, the (app) layout can unmount the
// screen before the sign-out finishes. One deletion runs at a time, for the
// Clerk session captured when the person confirmed it.
//
// The steps: stop this device's registration and let one already sent
// settle, call `identity/accountDeletion:deleteAccount`, which revokes every
// connection and removes every device including this one, then end the
// captured Clerk session. The sign-in screen then says the account is being
// deleted and by when. A failed call keeps the session signed in with a
// retry. A failed sign-out after the deletion committed retries only the
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

// Mounted at the root inside NotificationProvider, so it outlives both route
// groups.
export function AccountDeletionProvider({ children }: { children: ReactNode }) {
  const { sessionId, signOut } = useAuth();
  const deleteAccount = useMutation(identity.accountDeletion.deleteAccount);
  const stopForDeletion = useStopForDeletion();
  const [run, setRun] = useState<Run | null>(null);
  const [notice, setNotice] = useState<(DeletionNotice & { session: string }) | null>(null);
  // The run in progress, set before any call, so a second press while one
  // runs does nothing.
  const inFlight = useRef<string | null>(null);
  // The committed deletion of each session, so a retry only signs out.
  const committed = useRef(new Map<string, number>());
  // The latest Clerk session, read when a late step completes.
  const current = useRef(sessionId);
  current.current = sessionId;

  // A notice belongs to the session that was deleted. Another session
  // signing in clears it.
  useEffect(() => {
    if (sessionId && notice !== null && notice.session !== sessionId) {
      setNotice(null);
    }
  }, [sessionId, notice]);

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
              const result = await stopForDeletion(session, () => deleteAccount({}));
              completeBy = result.completeBy;
              committed.current.set(session, completeBy);
            } catch {
              fail(DELETE_FAILED, null);
              return;
            }
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
    [deleteAccount, signOut, stopForDeletion],
  );

  const value = useMemo(
    () => ({
      run,
      notice: notice === null ? null : { completeBy: notice.completeBy },
      start,
    }),
    [run, notice, start],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

// The Account screen's view of the deletion for its own session: the
// status, and `start` to begin or retry. A run for another session shows as
// idle.
export function useAccountDeletion(session: string | null | undefined): {
  status: DeletionStatus;
  start: () => void;
} {
  const { run, start } = useDeletionContext();
  const status: DeletionStatus =
    session && run !== null && run.session === session ? run.status : { kind: "idle" };
  return {
    status,
    start: () => {
      if (session) {
        start(session);
      }
    },
  };
}

// The notice's text, with the deadline in the device's locale, for example
// "Oct 14, 2026, 3:00 PM".
export function deletionNoticeText(completeBy: number): string {
  const when = new Date(completeBy).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `Your account is being deleted. Its data will be removed by ${when}.`;
}

// The sign-in screen's notice after this device deleted an account.
export function useDeletionNotice(): DeletionNotice | null {
  return useDeletionContext().notice;
}
