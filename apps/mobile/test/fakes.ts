// In-memory stand-ins for Clerk and the Convex client. Tests drive them
// directly: they set the Clerk session, script the sign-in and sign-up
// results, and control when ensureAccount settles. No test reaches Clerk or a
// Convex deployment.

type Listener = () => void;
type Result = { error: unknown };

const ok: Result = { error: null };

function store<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T>) {
      state = { ...state, ...patch };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset(next: T) {
      state = next;
    },
  };
}

export const clerkState = store({
  isLoaded: true,
  isSignedIn: false,
  sessionId: null as string | null,
});

export const convexAuthState = store({ isLoading: false, isAuthenticated: false });

// Signs a session in on both sides, as ConvexProviderWithClerk reports once
// the backend accepts the session's token.
export function signInAs(sessionId: string) {
  clerkState.set({ isSignedIn: true, sessionId });
  convexAuthState.set({ isLoading: false, isAuthenticated: true });
}

export function signOutAll() {
  clerkState.set({ isSignedIn: false, sessionId: null });
  convexAuthState.set({ isLoading: false, isAuthenticated: false });
}

export const signOut = jest.fn<Promise<void>, [{ sessionId?: string }?]>();

export const signIn = {
  status: "needs_identifier",
  emailCode: {
    sendCode: jest.fn<Promise<Result>, [{ emailAddress: string }?]>(),
    verifyCode: jest.fn<Promise<Result>, [{ code: string }]>(),
  },
  finalize: jest.fn<Promise<Result>, []>(),
};

export const signUp = {
  status: "missing_requirements",
  create: jest.fn<Promise<Result>, [{ emailAddress: string }]>(),
  verifications: {
    sendEmailCode: jest.fn<Promise<Result>, []>(),
    verifyEmailCode: jest.fn<Promise<Result>, [{ code: string }]>(),
  },
  finalize: jest.fn<Promise<Result>, []>(),
};

export const account = {
  _id: "users_1",
  _creationTime: 0,
  clerkUserId: "user_a",
  email: "a@example.com",
};

export const ensureAccount = jest.fn<Promise<typeof account>, [Record<string, never>]>();

// A promise a test settles when it chooses.
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A Clerk API failure as the sign-in and sign-up methods return it.
export function clerkApiError(code: string, message: string) {
  return { errors: [{ code, message, longMessage: message }] };
}

// Restores the signed-out state and each fake's default behavior: every Clerk
// step succeeds, finalizing signs a session in, and ensureAccount resolves at
// once.
export function resetFakes() {
  clerkState.reset({ isLoaded: true, isSignedIn: false, sessionId: null });
  convexAuthState.reset({ isLoading: false, isAuthenticated: false });
  signIn.status = "needs_identifier";
  signUp.status = "missing_requirements";
  // Clerk's signOut({ sessionId }) ends only that session.
  signOut.mockReset().mockImplementation(async (options) => {
    if (options?.sessionId === undefined || options.sessionId === clerkState.get().sessionId) {
      signOutAll();
    }
  });
  signIn.emailCode.sendCode.mockReset().mockResolvedValue(ok);
  signIn.emailCode.verifyCode.mockReset().mockImplementation(async () => {
    signIn.status = "complete";
    return ok;
  });
  signIn.finalize.mockReset().mockImplementation(async () => {
    signInAs("sess_signed_in");
    return ok;
  });
  signUp.create.mockReset().mockResolvedValue(ok);
  signUp.verifications.sendEmailCode.mockReset().mockResolvedValue(ok);
  signUp.verifications.verifyEmailCode.mockReset().mockImplementation(async () => {
    signUp.status = "complete";
    return ok;
  });
  signUp.finalize.mockReset().mockImplementation(async () => {
    signInAs("sess_signed_up");
    return ok;
  });
  ensureAccount.mockReset().mockResolvedValue(account);
}
