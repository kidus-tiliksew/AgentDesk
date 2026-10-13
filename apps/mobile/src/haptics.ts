import * as Haptics from "expo-haptics";

// Apple HIG Playing haptics: a success, warning, or error notification
// haptic confirms the outcome of a significant action, and a selection
// haptic marks a change of selection. Haptics are feedback only, so a device
// without them (or a failing call) changes nothing.
export const haptic = {
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(noop),
  warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(noop),
  error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(noop),
  selection: () => Haptics.selectionAsync().catch(noop),
};

function noop() {}
