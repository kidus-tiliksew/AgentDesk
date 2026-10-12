# @agentdesk/mobile

The AgentDesk Expo app (`component-mobile-app`). This guide takes a fresh checkout to the inbox on an iOS simulator, as a development build against your own Clerk instance and Convex dev deployment. Every requirement below was observed on a first run on 2026-10-12.

## 1. Toolchain

- **Node 22.** The root `package.json` requires `>=22 <23`. Run `pnpm install` from the repository root.
- **Xcode 27 or later.** Xcode 26.1.1 (Swift 6.2.1) cannot build the native modules:
  - `expo-modules-jsi` fails with `'weak' must be a mutable variable` on its `weak let` declarations, and with C++ interop errors such as `cannot be annotated with either SWIFT_RETURNS_RETAINED or SWIFT_RETURNS_UNRETAINED` in `RuntimeScheduler.h`.
  - `clerk-ios` fails the same way.

  Xcode 27.0 (Swift 6.4) builds the app.
- **Simulator.** Xcode 27 ships no standalone Simulator app. Install an iOS simulator runtime from Xcode's settings. `npx expo run:ios` boots the simulator and opens the app.

The iOS deployment target is 17.0, the minimum `@clerk/expo`'s native module supports. `app.config.ts` sets it through the `@clerk/expo` config plugin, so every prebuild and EAS build gets it. Never edit `ios/` or `android/`. Both are generated, git-ignored output.

## 2. Clerk instance

In the Clerk dashboard for the instance whose publishable key the app uses:

1. **Turn passwords off, or make them optional.** The app collects only an email address and the emailed code. If a password is required, sign-up stays at `missing_requirements` after the code verifies, and the app offers to start sign-up again.
2. **Activate the Convex integration.** It adds `aud: "convex"` to the session token. `ConvexProviderWithClerk` then sends the session token itself instead of requesting a `convex` JWT template.
3. **Add an `email` claim to the session token.** Under Sessions, customize the session token with:

   ```json
   { "email": "{{user.primary_email_address}}" }
   ```

   The backend creates the account from the token's email and refuses a token without one. The app then ends the Clerk session and returns to sign-in.

## 3. Convex deployment

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
2. Build and run a simulator development build:

   ```sh
   npx expo run:ios
   ```

Expo Go cannot load this app. It depends on `expo-dev-client` and Clerk's native module, which only a development build contains. After the first build, `npx expo start` serves JavaScript changes to the installed development build.

## 5. Notification actions

Pushed approve-or-reject decisions and single-choice decisions with two or three options carry buttons that answer without opening the app (`component-mobile-app` §Notifications). The app entry `index.ts` loads `src/notification-action-task.ts` before `expo-router/entry`. That module registers the categories `decision-approve-reject`, `decision-choice-2`, and `decision-choice-3` and installs the response listener. On Android it also defines the notification task.

Native configuration and its limits:

- **Android.** `expo-task-manager` runs the notification task `agentdesk-notification-action` when a button is pressed while the app is in the background or not running. The package's config plugin only adds the iOS `fetch` background mode, which nothing here uses, so `app.config.ts` does not list it. Prebuild still applies it on its own, as one of Expo's automatic plugins for installed packages, so the generated iOS `Info.plist` declares `fetch`. Android has no authentication option for a notification action.
- **iOS.** The notification task never receives a button press on iOS, because expo-notifications 57 runs it only when a push is received. The response listener and the launch response carry the press instead. The local Expo module `modules/notification-action-background` registers with expo-notifications' `NotificationCenterManager` at launch. It begins a `UIApplication` background task for each AgentDesk button press before expo-notifications completes the response. The JavaScript ends that task once the answer, the dismissal, or the outcome notification has settled, and iOS ends it on expiry. iOS grants about 30 seconds and guarantees no duration. When the window expires before the answer is sent, the app sends nothing and posts "Could not answer. Open AgentDesk to try again." if JavaScript is still running. If iOS suspends the app first, the press can end with no notification at all. Every iOS action requires Face ID or the passcode on a locked iPhone. No `remote-notification` background mode is configured, because receiving a push in the background is not how a button press reaches the app.
- Expo autolinking finds the local module in `modules/`. `npx expo prebuild --platform ios` adds its pod, `NotificationActionBackground`, to the generated project. `ios/` and `android/` stay generated and git-ignored. A build without the module still answers, but without protected background time.

### Device check before each store release

Jest covers the JavaScript with fakes and cannot show native timing. Before each store release, the operator checks the following on one physical iPhone and one Android phone, on a development or release build with EAS push credentials:

1. Each button of each category: Approve and Reject, Option 1 and 2, and Option 1 to 3. Each press answers the decision and removes the notification.
2. Presses with the app in the background and with the app not running.
3. On a locked iPhone, a press asks for Face ID or the passcode before anything is sent.
4. A decision answered elsewhere first, a decision that expired with and without a default, and a cancelled decision. Each posts its outcome notification.
5. A slow or offline network, and a press left until the window expires. The app posts "Could not answer. Open AgentDesk to try again." or nothing, and never a false success.
6. A tap on the notification body still opens the decision.
7. After signing out, a press on a notification delivered before the sign-out posts "Sign in to AgentDesk to answer" and answers nothing.

## Tests

`pnpm test` in this directory runs the Jest suite. The root `pnpm check` runs it after typechecking, linting, and the Vitest suites.
