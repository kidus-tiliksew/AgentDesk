import type { ReactNode } from "react";
import { Pressable, type StyleProp, View, type ViewStyle } from "react-native";
import { makeStyles, radius, spacing } from "../theme";

const useStyles = makeStyles((theme) => ({
  card: {
    backgroundColor: theme.card,
    borderRadius: radius.card,
    marginHorizontal: spacing.screen,
    padding: 14,
    gap: 6,
  },
  pressed: { opacity: 0.7 },
}));

// A rounded surface on the screen background. With `onPress` it is a button.
export function Card({
  children,
  onPress,
  accessibilityLabel,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  if (onPress === undefined) {
    return (
      <View
        accessible={accessibilityLabel !== undefined}
        accessibilityLabel={accessibilityLabel}
        style={[styles.card, style]}
      >
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed, style]}
    >
      {children}
    </Pressable>
  );
}
