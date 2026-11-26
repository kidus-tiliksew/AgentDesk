# Native check of the cold notification press handoff

A notification button pressed while the app is not running can launch it with
no scene. `ios/ColdPressHostStart.swift` then starts the React host, but only
after expo-notifications has queued every press it has recorded. This check proves that order
against the pinned expo-notifications source.

From `apps/mobile`, on a Mac with Xcode 27 and `pnpm install` done:

```sh
modules/notification-action-background/native-check/run.sh
```

The script copies these files into `Generated/`, which Git ignores:

- `NotificationCenterManager.swift` from the installed expo-notifications.
- `Mutex.swift` from the installed expo-modules-core.
- `ColdPressHostStart.swift` from `../ios`.

The script makes two edits to the manager copy, and prints them. A test
process has no app bundle, so `UNUserNotificationCenter.current()` stops it.
The edits remove that call and point the manager's delegate check at a stub.
The delegate loop and the response queue stay as pinned. When an Expo upgrade
changes the edited lines, the script stops instead of testing other code.

The tests run on macOS with `swift test`. A fake emitter stands in for
expo-notifications' `EmitterModule`, and a fake host registers it when the
host starts. The control test shows that an emitter that registers inside the
delegate loop misses the press. The other tests show that the emitter receives
each press once in both registration orders, off the main thread too. The
overlap control shows that a host started while a second press is between
the delegate list copy and the queue append misses that press. The overlap
test holds the second press there after the first press is queued, and shows
that the host waits, starts once, and the emitter receives both presses.

The check does not build the app or run JavaScript. The Jest suites cover the
JavaScript response handler. A physical iPhone shows the native timing.
