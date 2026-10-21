# Emulator evidence for task 261021-bce14d

Screenshots from the Android emulator check of the mobile app's development
build. The branch holds evidence only and is not merged.

- Emulator: AVD `Pixel_7_API_VanillaIceCream`, which reports API 34 (Android 14),
  1080x2400 at 420 dpi, gesture navigation, started with
  `-dns-server 8.8.8.8,1.1.1.1`.
- Build: `./gradlew app:assembleDebug -PreactNativeArchitectures=arm64-v8a` in the
  generated `apps/mobile/android`, then the dev client against local Metro.
- Account: the Clerk development instance with a `+clerk_test` address, on the
  development Convex deployment. A test agent session and its decisions were
  seeded there with the deployment's dev-only internal mutations.
- The round gear at the top right is the Expo dev client's tools button. It is
  not part of the app.

`before-*` images show defects at the base commit. `after-*` images show the
same screens after the fix.
