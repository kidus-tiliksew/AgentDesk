import { getItemAsync, setItemAsync } from "expo-secure-store";
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "./button";
import { SCREEN_PADDING } from "./styles";
import { makeStyles, radius, useTheme } from "./theme";
import { Icon } from "./ui/icon";
import { AppText } from "./ui/text";

// The explanation shown before the system's notification prompt (Apple HIG
// Privacy: request permission only when people use a feature that needs it,
// and explain why first). NotificationSession shows it while this install's
// permission was never asked; Continue goes on to the system prompt, and Not
// now closes it without asking.

export type PushIntroChoice = "continue" | "not-now";

// The person's answer lives in secure storage beside the install id, so the
// explanation shows once per install, not on every launch. After Not now,
// Settings → Notifications can still turn push on, and asks directly; after
// Continue, a prompt the app never got to show is asked directly next time.
export const PUSH_INTRO_KEY = "agentdesk.pushIntro";

// A storage failure reads as no answer: showing the explanation again is
// better than never offering push.
export async function readPushIntroChoice(): Promise<PushIntroChoice | null> {
  try {
    const stored = await getItemAsync(PUSH_INTRO_KEY);
    return stored === "continue" || stored === "not-now" ? stored : null;
  } catch {
    return null;
  }
}

// A storage failure is dropped; the explanation returns on the next launch.
export async function rememberPushIntroChoice(choice: PushIntroChoice): Promise<void> {
  await setItemAsync(PUSH_INTRO_KEY, choice).catch(() => undefined);
}

const TITLE = "Get a buzz when an agent needs you";
const BODY =
  "AgentDesk notifies you when an agent asks for a decision or finishes its work, and you can answer right from the notification.";
const RULES = "Your rules and quiet hours decide what buzzes.";

const useStyles = makeStyles((theme) => ({
  screen: { backgroundColor: theme.background, flex: 1 },
  content: { flexGrow: 1, gap: 32, justifyContent: "center" },
  copy: { alignItems: "center", gap: 12 },
  tile: {
    alignItems: "center",
    backgroundColor: theme.card,
    borderRadius: radius.card + 6,
    justifyContent: "center",
    marginBottom: 8,
    minHeight: 88,
    minWidth: 88,
  },
  center: { textAlign: "center" },
  actions: { gap: 8 },
}));

export function PushIntro({
  visible,
  onContinue,
  onNotNow,
}: {
  visible: boolean;
  onContinue: () => void;
  onNotNow: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const title = useRef<View>(null);

  // VoiceOver starts on the title, so the explanation reads before the
  // choice (Apple HIG Accessibility).
  useEffect(() => {
    if (visible && title.current !== null) {
      AccessibilityInfo.sendAccessibilityEvent(title.current, "focus");
    }
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onNotNow}
    >
      {/* accessibilityViewIsModal keeps VoiceOver inside the explanation
          until the person chooses. The content scrolls, so the largest
          text sizes still reach both buttons. */}
      <View accessibilityViewIsModal style={styles.screen}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: SCREEN_PADDING + insets.top,
              paddingRight: SCREEN_PADDING + insets.right,
              paddingBottom: SCREEN_PADDING + insets.bottom,
              paddingLeft: SCREEN_PADDING + insets.left,
            },
          ]}
        >
          <View style={styles.copy}>
            <View style={styles.tile}>
              <Icon name="notifications" size={44} color={theme.accent} />
            </View>
            <View ref={title} accessible accessibilityRole="header" accessibilityLabel={TITLE}>
              <AppText variant="title2" style={styles.center}>
                {TITLE}
              </AppText>
            </View>
            <AppText tone="secondary" style={styles.center}>
              {BODY}
            </AppText>
            <AppText tone="secondary" style={styles.center}>
              {RULES}
            </AppText>
          </View>
          <View style={styles.actions}>
            <Button label="Continue" onPress={onContinue} />
            <Button label="Not now" variant="plain" onPress={onNotNow} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
