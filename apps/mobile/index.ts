// The app entry (component-mobile-app §Notifications). The notification
// action wiring loads first, so its Android notification task and its
// response listener exist at module scope when the app starts in the
// background, before expo-router mounts any screen.
import "./src/notification-action-task";
import "expo-router/entry";
