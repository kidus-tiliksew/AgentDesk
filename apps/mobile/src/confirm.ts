import { ActionSheetIOS, Alert, Platform } from "react-native";

// Asks the person to confirm a destructive choice with the system's own
// control: an action sheet on iOS and an alert on Android. Apple HIG Action
// sheets: a destructive action the person started gets the destructive
// choice in red and a separate cancel choice, so a stray tap never runs it.
// `onConfirm` runs only when the destructive choice is picked.
export function confirmDestructive({
  title,
  message,
  action,
  cancel = "Cancel",
  onConfirm,
}: {
  title?: string;
  message?: string;
  action: string;
  cancel?: string;
  onConfirm: () => void;
}) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        ...(title === undefined ? {} : { title }),
        ...(message === undefined ? {} : { message }),
        options: [action, cancel],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      (index) => {
        if (index === 0) {
          onConfirm();
        }
      },
    );
    return;
  }
  // An Android alert needs a title; without one it asks with the action.
  Alert.alert(title ?? `${action}?`, message, [
    { text: cancel, style: "cancel" },
    { text: action, style: "destructive", onPress: onConfirm },
  ]);
}

// Apple HIG Modality: leaving a sheet or form with unsaved edits asks first,
// so a swipe or a Cancel never throws away work silently. "Keep Editing"
// stays; "Discard Changes" runs `onDiscard`.
export function confirmDiscard(onDiscard: () => void) {
  confirmDestructive({
    action: "Discard Changes",
    cancel: "Keep Editing",
    onConfirm: onDiscard,
  });
}
