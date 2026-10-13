import { type ReactNode, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, View } from "react-native";
import { useTheme } from "../theme";
import { AppText } from "./text";

const ACTION_WIDTH = 88;

// A row that slides left to reveal one destructive action, such as Delete or
// Revoke. The action is also exposed as an accessibility action named by its
// label, so VoiceOver and tests can run it without the gesture. Pressing the
// revealed button calls `onAction`; the caller confirms if it needs to.
export function SwipeRow({
  actionLabel,
  onAction,
  children,
}: {
  actionLabel: string;
  onAction: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  // Mirrors `open` for rendering: the hidden button stays out of VoiceOver's
  // reach until the row is open (the accessibility action covers it).
  const [revealed, setRevealed] = useState(false);
  const settle = (to: number) => {
    open.current = to !== 0;
    setRevealed(open.current);
    Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 0 }).start();
  };
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_e, g) => {
        const base = open.current ? -ACTION_WIDTH : 0;
        x.setValue(Math.min(0, Math.max(-ACTION_WIDTH * 1.2, base + g.dx)));
      },
      onPanResponderRelease: (_e, g) => {
        const base = open.current ? -ACTION_WIDTH : 0;
        settle(base + g.dx < -ACTION_WIDTH / 2 ? -ACTION_WIDTH : 0);
      },
      onPanResponderTerminate: () => settle(open.current ? -ACTION_WIDTH : 0),
    }),
  ).current;
  return (
    <View
      accessibilityActions={[{ name: actionLabel, label: actionLabel }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === actionLabel) {
          onAction();
        }
      }}
      style={{ overflow: "hidden" }}
    >
      <View
        style={{
          backgroundColor: theme.redFill,
          bottom: 0,
          position: "absolute",
          right: 0,
          top: 0,
          width: ACTION_WIDTH,
        }}
      >
        <Pressable
          accessibilityElementsHidden={!revealed}
          importantForAccessibility={revealed ? "auto" : "no-hide-descendants"}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={() => {
            settle(0);
            onAction();
          }}
          style={{ alignItems: "center", flex: 1, justifyContent: "center" }}
        >
          <AppText weight="600" style={{ color: "#ffffff" }}>
            {actionLabel}
          </AppText>
        </Pressable>
      </View>
      <Animated.View
        {...responder.panHandlers}
        style={{ backgroundColor: theme.card, transform: [{ translateX: x }] }}
      >
        {children}
      </Animated.View>
    </View>
  );
}
