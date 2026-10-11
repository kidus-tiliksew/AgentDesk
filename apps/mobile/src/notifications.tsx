import { useAuth } from "@clerk/expo";
import { useMutation } from "convex/react";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, Platform } from "react-native";
import { notifications } from "../../../convex/notifications/refs";
import { ensureInstallId, readInstallId } from "./install-id";
import { notificationRoute } from "./notification-route";

// component-mobile-app §Notifications: device registration, tap routing,
// foreground presentation, and the device half of sign-out (DEC-7,
// req-mobile-app REQ-4, AC-4.2). Push delivery and per-device deduplication
// belong to component-notifications; the app only registers and routes.

export type RegisterDevice = (args: {
  deviceId: string;
  pushToken: string;
  platform: "ios" | "android";
  name: string;
}) => Promise<null>;
export type UnregisterDevice = (args: { deviceId: string }) => Promise<null>;

export type SetupFailure = "unsupported" | "project" | "storage" | "token" | "register";

export type RegistrationStatus =
  | { kind: "off" }
  | { kind: "setting-up" }
  | { kind: "registered" }
  | { kind: "denied" }
  | { kind: "failed"; reason: SetupFailure };

// The Android channel every push lands in. component-notifications sends no
// channel id, so Android uses the default channel the plugin names.
export const ANDROID_CHANNEL_ID = "default";

// Foreground presentation: a push that arrives while the app is open shows in
// the banner and the notification list with no sound and no badge change. It
// never navigates on receipt; the inbox's reactive queries update on their
// own (AC-2.3). On Android, a notification without sound shows in the list
// without a heads-up banner.
export const FOREGROUND_BEHAVIOR: Notifications.NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

class SetupError extends Error {
  constructor(readonly reason: SetupFailure) {
    super(reason);
  }
}

function readProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const fromConfig = extra?.eas?.projectId;
  const projectId = typeof fromConfig === "string" ? fromConfig : Constants.easConfig?.projectId;
  return typeof projectId === "string" && projectId.trim() !== "" ? projectId.trim() : null;
}

function deviceName(platform: "ios" | "android"): string {
  for (const name of [Device.deviceName, Device.modelName]) {
    if (typeof name === "string" && name.trim() !== "") {
      return name.trim();
    }
  }
  return platform === "ios" ? "iPhone" : "Android phone";
}

// Owns this install's registration for one Clerk session at a time. Every
// device mutation runs on one queue, so an unregistration waits for a
// registration already sent. A run number marks each start; a result from an
// earlier run, an earlier session, or a run that sign-out stopped is dropped
// before it reaches the queue, so a late token cannot register the device
// again after it was unregistered.
export class DeviceRegistration {
  private status: RegistrationStatus = { kind: "off" };
  private readonly listeners = new Set<() => void>();
  private session: string | null = null;
  private register: RegisterDevice | null = null;
  private run = 0;
  private signingOut = false;
  private queue: Promise<unknown> = Promise.resolve();
  private registered: { session: string; token: string } | null = null;
  // One permission request per session, shared by every run, so a remount
  // does not prompt twice.
  private permissionRequest: Promise<Notifications.NotificationPermissionsStatus> | null = null;
  private setup: Promise<void> | null = null;
  private rerun: { force: boolean } | null = null;

  getStatus = () => this.status;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setStatus(status: RegistrationStatus) {
    this.status = status;
    for (const listener of this.listeners) {
      listener();
    }
  }

  // Starts registration for `session` after its account is ready, and
  // returns the cleanup that stops this run.
  start(session: string, register: RegisterDevice): () => void {
    if (this.session !== session) {
      this.session = session;
      this.signingOut = false;
      this.registered = null;
      this.permissionRequest = null;
    }
    this.register = register;
    const run = ++this.run;
    this.setup = null;
    this.rerun = null;

    // A native token change needs a new Expo token: getExpoPushTokenAsync
    // sends the new device token to Expo, and registerDevice stores the Expo
    // token. The raw APNs or FCM token is never sent to the backend.
    const tokenSubscription = Notifications.addPushTokenListener(() => {
      this.refresh(run, { force: true });
    });
    // A return to the foreground picks up a permission granted in system
    // settings and retries a failed setup.
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        this.refresh(run, { force: false });
      }
    });
    this.refresh(run, { force: false });

    return () => {
      tokenSubscription.remove();
      appStateSubscription.remove();
      if (this.run === run) {
        this.run++;
        this.setup = null;
        this.rerun = null;
        this.setStatus({ kind: "off" });
      }
    };
  }

  // Runs setup again for the current run, for example from a retry button.
  retry() {
    this.refresh(this.run, { force: false });
  }

  private live(run: number) {
    return this.run === run && !this.signingOut;
  }

  private refresh(run: number, options: { force: boolean }) {
    if (!this.live(run)) {
      return;
    }
    if (this.setup !== null) {
      // One setup at a time; a request during it runs once more after it.
      this.rerun = { force: (this.rerun?.force ?? false) || options.force };
      return;
    }
    const setup = this.runSetup(run, options.force).finally(() => {
      if (this.setup !== setup) {
        return;
      }
      this.setup = null;
      const again = this.rerun;
      this.rerun = null;
      if (again !== null) {
        this.refresh(run, again);
      }
    });
    this.setup = setup;
  }

  private async runSetup(run: number, force: boolean) {
    const session = this.session;
    const register = this.register;
    if (session === null || register === null) {
      return;
    }
    if (this.status.kind !== "registered") {
      this.setStatus({ kind: "setting-up" });
    }
    try {
      if ((Platform.OS !== "ios" && Platform.OS !== "android") || !Device.isDevice) {
        throw new SetupError("unsupported");
      }
      const platform = Platform.OS;
      if (platform === "android") {
        // The channel exists before the permission prompt, so Android 13
        // shows the prompt.
        await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
          name: "Decisions and agents",
          importance: Notifications.AndroidImportance.HIGH,
        });
      }
      let permission = await Notifications.getPermissionsAsync();
      if (!permission.granted && permission.canAskAgain) {
        this.permissionRequest ??= Notifications.requestPermissionsAsync();
        permission = await this.permissionRequest;
      }
      if (!this.live(run)) {
        return;
      }
      if (!permission.granted) {
        // Denied: register nothing, and every screen keeps working.
        this.setStatus({ kind: "denied" });
        return;
      }
      const projectId = readProjectId();
      if (projectId === null) {
        throw new SetupError("project");
      }
      const deviceId = await ensureInstallId().catch(() => {
        throw new SetupError("storage");
      });
      const token = await Notifications.getExpoPushTokenAsync({ projectId }).then(
        (result) => result.data,
        () => {
          throw new SetupError("token");
        },
      );
      if (!this.live(run)) {
        return;
      }
      await this.enqueue(async () => {
        // Checked again when the call would go out: sign-out may have
        // started while earlier work ran.
        if (!this.live(run)) {
          return;
        }
        const current = this.registered;
        if (!force && current !== null && current.session === session && current.token === token) {
          return;
        }
        await register({ deviceId, pushToken: token, platform, name: deviceName(platform) });
        if (this.session === session) {
          this.registered = { session, token };
        }
      }).catch(() => {
        throw new SetupError("register");
      });
      if (this.live(run)) {
        this.setStatus({ kind: "registered" });
      }
    } catch (error) {
      if (this.live(run)) {
        this.setStatus({
          kind: "failed",
          reason: error instanceof SetupError ? error.reason : "register",
        });
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // The device half of sign-out (AC-4.2). It stops new registration for
  // `session`, lets a registration already sent settle, then unregisters the
  // stored install id. An install with no stored id was never registered, so
  // there is nothing to unregister. A storage failure rejects instead,
  // because the id is unknown. Registration stays stopped for the session
  // after this call, whether it succeeds or fails, so a retry of the Clerk
  // sign-out never races a new registration.
  async stopForSignOut(session: string, unregister: UnregisterDevice): Promise<void> {
    if (this.session === session) {
      this.signingOut = true;
      this.rerun = null;
    }
    await this.enqueue(async () => {
      const deviceId = await readInstallId();
      if (deviceId !== null) {
        await unregister({ deviceId });
      }
      if (this.session === session) {
        this.registered = null;
      }
    });
  }
}

// A captured tap waiting for the routes to be ready.
type Tap = { route: ReturnType<typeof notificationRoute> };

class TapInbox {
  private pending: Tap | null = null;
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<() => void>();

  get = () => this.pending;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // A response seen before, for example the launch response that the live
  // listener also delivers, is ignored, so one tap navigates once.
  capture(response: Notifications.NotificationResponse) {
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
      return;
    }
    const id = response.notification.request.identifier;
    if (this.seen.has(id)) {
      return;
    }
    this.seen.add(id);
    this.pending = { route: notificationRoute(response.notification.request.content.data) };
    this.emit();
  }

  take(): Tap | null {
    const tap = this.pending;
    if (tap !== null) {
      this.pending = null;
      this.emit();
    }
    return tap;
  }

  clear() {
    if (this.pending !== null) {
      this.pending = null;
      this.emit();
    }
  }
}

type NotificationContext = { registration: DeviceRegistration; taps: TapInbox };

const Context = createContext<NotificationContext | null>(null);

function useNotificationContext(): NotificationContext {
  const value = useContext(Context);
  if (value === null) {
    throw new Error("NotificationProvider is missing");
  }
  return value;
}

// Mounted at the root, inside Clerk and Convex and before any route guard,
// so a tap that launched the app is captured while sign-in or account setup
// is still on screen.
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [value] = useState<NotificationContext>(() => ({
    registration: new DeviceRegistration(),
    taps: new TapInbox(),
  }));
  const { sessionId } = useAuth();
  // The last session Clerk reported as established. Clerk reports
  // `undefined` while it loads and `null` when signed out; neither is an
  // established session.
  const established = useRef<string | null>(null);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => FOREGROUND_BEHAVIOR,
    });
    return () => Notifications.setNotificationHandler(null);
  }, []);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) =>
      value.taps.capture(response),
    );
    // The tap that launched the app. Clearing it after capture keeps a later
    // mount from reading it again.
    const launch = Notifications.getLastNotificationResponse();
    if (launch !== null) {
      value.taps.capture(launch);
      Notifications.clearLastNotificationResponse();
    }
    return () => subscription.remove();
  }, [value]);

  // A tap waiting when an established session ends or changes is dropped, so
  // it cannot open a screen in the next person's session. A tap captured
  // while Clerk loads or while signed out waits through sign-in, so a tap
  // that launched the app survives Clerk's undefined-to-null or
  // undefined-to-session start (REQ-4). A return to loading is not an end.
  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    if (established.current !== null && established.current !== sessionId) {
      value.taps.clear();
    }
    established.current = sessionId;
  }, [sessionId, value]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

// Mounted inside the account gate, so it runs only after Clerk and Convex
// accept the session and ensureAccount succeeds. It starts registration for
// the session and opens a captured tap's screen.
export function NotificationSession() {
  const { registration, taps } = useNotificationContext();
  const { sessionId } = useAuth();
  const register = useMutation(notifications.devices.registerDevice);
  const router = useRouter();
  const tap = useSyncExternalStore(taps.subscribe, taps.get);

  useEffect(() => {
    if (sessionId === null || sessionId === undefined) {
      return;
    }
    return registration.start(sessionId, register);
  }, [registration, sessionId, register]);

  useEffect(() => {
    if (tap === null) {
      return;
    }
    const taken = taps.take();
    if (taken === null) {
      return;
    }
    if (taken.route === "/") {
      router.navigate("/");
    } else {
      router.push(taken.route);
    }
  }, [tap, taps, router]);

  return null;
}

export function useRegistrationStatus(): { status: RegistrationStatus; retry: () => void } {
  const { registration } = useNotificationContext();
  const status = useSyncExternalStore(registration.subscribe, registration.getStatus);
  return { status, retry: () => registration.retry() };
}

// The account screen's sign-out: unregister this install, then end the exact
// Clerk session. `device` failures leave the session signed in.
export function useSignOutDevice() {
  const { registration } = useNotificationContext();
  const unregister = useMutation(notifications.devices.unregisterDevice);
  return (session: string) => registration.stopForSignOut(session, unregister);
}
