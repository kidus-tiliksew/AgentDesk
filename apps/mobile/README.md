# @agentdesk/mobile

The AgentDesk Expo app (`component-mobile-app`). This guide takes a fresh checkout to the inbox on an iOS simulator or an Android emulator, as a development build against your own Clerk instance and Convex dev deployment. The iOS requirements below were observed on a first run on 2026-10-12, and the Android requirements on a first run on 2026-10-21.

## 1. Toolchain

### Both platforms

- **Node 22.** The root `package.json` requires `>=22 <23`. Run `pnpm install` from the repository root.

Never edit `ios/` or `android/`. Both are generated, git-ignored output.

### iOS

- **Xcode 27 or later.** Xcode 26.1.1 (Swift 6.2.1) cannot build the native modules:
  - `expo-modules-jsi` fails with `'weak' must be a mutable variable` on its `weak let` declarations, and with C++ interop errors such as `cannot be annotated with either SWIFT_RETURNS_RETAINED or SWIFT_RETURNS_UNRETAINED` in `RuntimeScheduler.h`.
  - `clerk-ios` fails the same way.

  Xcode 27.0 (Swift 6.4) builds the app.
- **Simulator.** Xcode 27 ships no standalone Simulator app. Install an iOS simulator runtime from Xcode's settings. `npx expo run:ios` boots the simulator and opens the app.

The iOS deployment target is 17.0, the minimum `@clerk/expo`'s native module supports. `app.config.ts` sets it through the `@clerk/expo` config plugin, so every prebuild and EAS build gets it.

### Android

An Android build needs no Xcode.

- **JDK 17 or later.**
- **Android SDK.** Install it, for example through Android Studio, and set `ANDROID_HOME` to its installation directory.
- **Emulator.** Install an Android emulator system image and create an Android Virtual Device (AVD) from it, for example in Android Studio's Device Manager.

The emulator image's API level is separate from the app's own API levels. The app takes the levels Expo SDK 57 ships: minimum API 24, and target and compile API 36. `app.config.ts` overrides none of them. The 2026-10-21 first run used an API 35 emulator image.

## 2. Clerk instance

These settings apply to both platforms.

In the Clerk dashboard for the instance whose publishable key the app uses:

1. **Turn passwords off, or make them optional.** The app collects only an email address and the emailed code. If a password is required, sign-up stays at `missing_requirements` after the code verifies, and the app offers to start sign-up again.
2. **Activate the Convex integration.** It adds `aud: "convex"` to the session token. `ConvexProviderWithClerk` then sends the session token itself instead of requesting a `convex` JWT template.
3. **Add an `email` claim to the session token.** Under Sessions, customize the session token with:

   ```json
   { "email": "{{user.primary_email_address}}" }
   ```

   The backend creates the account from the token's email and refuses a token without one. The app then ends the Clerk session and returns to sign-in.

## 3. Convex deployment

This deployment serves both platforms.

Run these from the repository root:

1. Select a dev deployment with `npx convex dev`. It writes `CONVEX_DEPLOYMENT` to the git-ignored `.env.local`. If the first push stops because `CLERK_JWT_ISSUER_DOMAIN` is not set, stop it and continue with the next step.
2. Set the Clerk instance's issuer, the Frontend API URL shown in the Clerk dashboard:

   ```sh
   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-instance>.clerk.accounts.dev
   ```

3. Push the functions before the first sign-in by running `npx convex dev`, or `pnpm dev`, which runs it. Against a deployment without the functions, the app shows "The AgentDesk backend did not accept this sign-in."

## 4. App build

From `apps/mobile`:

1. Copy `.env.example` to `.env` and replace the placeholders with your Convex deployment URL and your Clerk publishable key.
2. Build and run a development build.

   On an iOS simulator:

   ```sh
   npx expo run:ios
   ```

   On an Android emulator, boot the AVD first, for example from Android Studio's Device Manager or with `"$ANDROID_HOME/emulator/emulator" -avd <your-avd-name>`, then run:

   ```sh
   npx expo run:android
   ```

Expo Go cannot load this app. It depends on `expo-dev-client` and Clerk's native module, which only a development build contains. After the first build, `npx expo start` serves JavaScript changes to the installed development build on either platform.

### Android build output

Keep the build output visible. On the 2026-10-21 first run, `npx expo run:android` piped through a log filter showed no progress, so the build could not be told apart from a stalled one. Run the command with its output unfiltered.

After `npx expo run:android` has generated `android/`, you can diagnose the native build on its own. From `apps/mobile/android`, with the output unfiltered:

```sh
./gradlew app:assembleDebug
```

This assembles the debug APK only. It neither installs nor launches the app; `npx expo run:android` does both. The generated `android/` directory stays git-ignored, and you never edit it.

### Android emulator cannot resolve host names

This note applies to the emulator only. It does not apply to a physical phone, and it does not fix every reason the app stays on "Loading".

The app stays on "Loading" while Clerk cannot load. Missing DNS in the emulator is one cause; a wrong publishable key or an unreachable network are others. Before you apply the workaround, confirm that the emulator cannot resolve host names: a web page opened in the emulator's browser fails with a "name not resolved" error. Do not change the Clerk setup to diagnose this.

On the 2026-10-21 first run, the Mac's VPN supplied the DNS resolvers, the emulator resolved no host names, and Clerk never loaded. To restart the emulator with public resolvers:

1. Stop the affected emulator.
2. Restart its existing AVD from a terminal, and keep the command's output visible:

   ```sh
   "$ANDROID_HOME/emulator/emulator" -avd <your-avd-name> -dns-server 8.8.8.8,1.1.1.1
   ```

   Replace `<your-avd-name>` with the AVD's name. `"$ANDROID_HOME/emulator/emulator" -list-avds` prints the names.
3. Open the installed development build again.

## 5. Notification actions

Pushed approve-or-reject decisions and single-choice decisions with two or three options carry buttons that answer without opening the app (`component-mobile-app` §Notifications). The app entry `index.ts` loads `src/notification-action-task.ts` before `expo-router/entry`. That module registers the categories `decision-approve-reject`, `decision-choice-2`, and `decision-choice-3` and installs the response listener. On Android it also defines the notification task.

Native configuration and its limits:

- **Android.** `expo-task-manager` runs the notification task `agentdesk-notification-action` when a button is pressed while the app is in the background or not running. The package's config plugin only adds the iOS `fetch` background mode, which nothing here uses, so `app.config.ts` does not list it. Prebuild still applies it on its own, as one of Expo's automatic plugins for installed packages, so the generated iOS `Info.plist` declares `fetch`. Android has no authentication option for a notification action.
- **iOS.** The notification task never receives a button press on iOS, because expo-notifications 57 runs it only when a push is received. The response listener and the launch response carry the press instead. The local Expo module `modules/notification-action-background` registers with expo-notifications' `NotificationCenterManager` at launch. It begins a `UIApplication` background task for each AgentDesk button press before expo-notifications completes the response. The JavaScript ends that task once the answer, the dismissal, or the outcome notification has settled, and iOS ends it on expiry. iOS grants about 30 seconds and guarantees no duration. When the window expires before the answer is sent, the app sends nothing and posts "Could not answer. Open AgentDesk to try again." if JavaScript is still running. If iOS suspends the app first, the press can end with no notification at all. Every iOS action requires Face ID or the passcode on a locked iPhone. No `remote-notification` background mode is configured, because receiving a push in the background is not how a button press reaches the app.
- Expo autolinking finds the local module in `modules/`. `npx expo prebuild --platform ios` adds its pod, `NotificationActionBackground`, to the generated project. `ios/` and `android/` stay generated and git-ignored. A build without the module still answers, but without protected background time.

### Device check before each store release

Jest covers the JavaScript with fakes and cannot show native timing. An emulator, a simulator, and the Jest suite do not replace these checks. Before each store release, the operator checks the following on one physical iPhone and one Android phone, on a development or release build with EAS push credentials.

On Android, the `default` channel's private lock-screen visibility leaves it to the phone's own lock-screen setting whether a locked phone shows a notification's text and buttons (DEC-17(6)). Run every step on the locked Android phone twice, once with each lock-screen setting. Device makers label the settings differently; pick the one with each meaning:

- **Hide sensitive content.** A locked phone shows only the app name, with no decision text and no buttons, until it is unlocked.
- **Show all content.** A locked phone shows the text and the buttons, and a press answers without unlock and without bringing the app forward.

Android offers no unlock requirement for a notification action. Android fixes a channel's lock-screen visibility when the app first creates the channel, so an install that created the channel with other settings can disagree with this list. Report such a mismatch; do not change native configuration to hide it.

1. Each button of each category: Approve and Reject, Option 1 and 2, and Option 1 to 3. Each press answers the decision and removes the notification.
   - Locked Android, hide sensitive content: no decision text and no buttons until unlock. After unlock, each press answers the decision and removes the notification.
   - Locked Android, show all content: the text and every button of the category show on the lock screen. Each press answers the decision and removes the notification without unlock.
2. Presses with the app in the background and with the app not running.
   - Locked Android, hide sensitive content: in both app states, the buttons stay hidden until unlock, and a press after unlock answers.
   - Locked Android, show all content: in both app states, a press on the lock screen answers without unlock and without opening the app.
3. On a locked iPhone, a press asks for Face ID or the passcode before anything is sent.
   - Locked Android, hide sensitive content: no button shows until unlock, so nothing can be pressed on the lock screen.
   - Locked Android, show all content: a press answers with no unlock. The device does not authenticate this answer; that is the expected Android behavior, not a failure.
4. A decision answered elsewhere first, a decision that expired with and without a default, and a cancelled decision. Each posts its outcome notification.
   - Locked Android, hide sensitive content: repeat each case, pressing a button after unlock. Each press posts the matching outcome notification. While the phone is locked, that notification shows only the app name.
   - Locked Android, show all content: repeat each case, pressing a button on the lock screen. Each press posts the matching outcome notification.
5. A slow or offline network, and a press left until the window expires. The app posts "Could not answer. Open AgentDesk to try again." or nothing, and never a false success.
   - Locked Android, hide sensitive content: repeat the slow network, the offline network, and the delayed press, pressing a button after unlock. Each ends with "Could not answer. Open AgentDesk to try again." or no notification, and never a false success.
   - Locked Android, show all content: repeat the same cases, pressing a button on the lock screen. Each ends with the same message or no notification, and never a false success.
   - The window that expires is the iOS background-time window. Android gives a press no such protected window, so on Android the delayed press checks only that no false success appears.
6. A tap on the notification body still opens the decision.
   - Locked Android, hide sensitive content: the notification shows no decision text. A body tap goes through the phone's unlock flow and then opens the decision.
   - Locked Android, show all content: a body tap opens the decision through the phone's normal unlock flow. Only a button press answers without unlock; a body tap answers nothing.
7. After signing out, a press on a notification delivered before the sign-out posts "Sign in to AgentDesk to answer" and answers nothing.
   - Locked Android, hide sensitive content: unlock, then press the button. The app posts "Sign in to AgentDesk to answer" and answers nothing. While the phone is locked, that notification shows only the app name.
   - Locked Android, show all content: press the button on the lock screen. The app posts "Sign in to AgentDesk to answer" and answers nothing.

## Tests

`pnpm test` in this directory runs the Jest suite. The root `pnpm check` runs it after typechecking, linting, and the Vitest suites.
