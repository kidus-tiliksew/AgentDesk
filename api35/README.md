# API 35 emulator evidence for task 261021-bce14d (review round 1)

- Emulator: new AVD `Pixel_7_API_35` from `system-images;android-35;google_apis;arm64-v8a`,
  which reports API 35 (Android 15, build AE3A.240806.043), 1080x2400 at 420 dpi,
  gesture navigation, hardware keyboard on, started with
  `-dns-server 8.8.8.8,1.1.1.1 -no-snapshot-save`. See `emulator-env.txt`.
- Build: `./gradlew app:assembleDebug -PreactNativeArchitectures=arm64-v8a` at
  `03a6f83`, run as a dev client against local Metro serving the task worktree.
- TalkBack 15.0.0.639625893 from the system image.

## How TalkBack was driven and recorded

`adb shell input` events bypass TalkBack, and emulator-console key events did
not reach the guest. With `adb root`, `sendevent` writes kernel key events into
the emulator's `qwerty2` keyboard device, which TalkBack receives as a
physical keyboard. Alt+Right and Alt+Left (TalkBack's default keymap) move
accessibility focus. TalkBack's developer log level was set to verbose
(`pref_log_level` = 2 in its device-protected preferences). Each file in
`talkback/` lists, in order, the text TalkBack sent to speech
(`Pipeline: execute() success=true … action=SPEAK text="…"`) while focus moved
one item at a time.

Walks named `*-fixed*`, `threshold-pause3`, and `decision-final-*` ran after
commit `40e0f5a`. The others ran at `03a6f83`, before it. Those files show the
defects that commit fixes: the decision title read only as "Urgent/Normal
priority", the email field read only as "you@example.com", the stale
threshold field read only as "30", and the separator read as "Middle dot".

The round gear labelled "Tools" is the Expo dev client's tools button, not
part of the app.
