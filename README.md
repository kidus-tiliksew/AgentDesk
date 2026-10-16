# Evidence for Conveyor task 261016-e5f947

Simulator screenshots for PR #138 (dock spacing and StackScreen scroll bottom insets). Each image puts the base commit 19da454 on the left and the fix a525a57 on the right.

- `pending-dock*.png`: iPhone 17 Pro simulator, iOS 26.1 (23B86), default text size.
- `scroll-end-*.png`: iPhone 17 Pro Max simulator, iOS 26.1 (23B86), text size accessibility-extra-extra-extra-large. Each screen was dragged to the end, then a final overscroll drag was released and allowed to settle for 2.5 s before capture.
- `keyboard-text-answer.png`: iPhone 17 Pro simulator, iOS 26.1, default text size. The answer field was focused through a temporary autoFocus debug edit that was never committed.

The Account screen was captured but is not published here because it shows the account email.

## SHA-256

```
147715d9bf6f19305a09059f14ef082d69cd2e3d8f0068f1eebf89e6a21aeca6  keyboard-text-answer.png
90e9a2db235b308c77674cb06462644bd6df196394e55e82192e5373ea5e03d8  pending-dock-full.png
47d4c6f28641db49b3382e52f85597b24dcca9d7d6dad0680ef7ce0f04c1e0ba  pending-dock.png
017bf089461745142957b3427a4deb2fbf5048b460cad1ca5be336d6475ea20c  scroll-end-addmachine.png
ec0d93f9709f3cd4782e9f904bc436cc6b5fde63d4cffcf39afc30abd6190494  scroll-end-agent.png
66c25f9d43a55415a435ab5e07280a68b410fda0e96a35ab3f3eb425b2888212  scroll-end-connections.png
5896733ff67bb3ea3c6976f576b4f9c412c1c268d06f11633a716ad2ed916e97  scroll-end-digest.png
dd651fc9958f3808d1afed8db8fef6dbdef5de93689d4d829c887272b3dd4be3  scroll-end-notifications.png
310bec7d992ed73016ce3aa5a5951199595d9f120188aaa34f073ec2a89bf1e8  scroll-end-ruleeditor.png
240ff894fda954bfaf8d0bde795a377dbb0d1441e736d771867a12f441d6b400  scroll-end-rules.png
ab29a9cede33a5d6412f439bf0fd265a532d6868365abce8c6edc51041ec088b  scroll-end-settled.png
```
