import type { ReactNode } from "react";
import { Pressable, ScrollView } from "react-native";
import { haptic } from "../haptics";
import { makeStyles, radius, spacing } from "../theme";
import { AppText } from "./text";

const useStyles = makeStyles((theme) => ({
  // The vertical padding leaves room for each chip's 5 pt hit slop, which a
  // ScrollView would otherwise clip.
  row: { gap: 8, paddingHorizontal: spacing.screen, paddingVertical: 5 },
  chip: {
    backgroundColor: theme.card,
    borderRadius: radius.pill,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  selected: { backgroundColor: theme.text },
  selectedLabel: { color: theme.background },
}));

// A selectable rounded chip. The selected chip inverts: text-colored fill with
// the label in the background color.
export function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      // The chip draws about 34 pt tall; the slop makes its hit region 44 pt.
      hitSlop={{ top: 5, bottom: 5 }}
      onPress={() => {
        if (!selected) {
          haptic.selection();
        }
        onPress();
      }}
      style={[styles.chip, selected && styles.selected]}
    >
      <AppText
        variant="subhead"
        weight={selected ? "600" : "500"}
        style={selected ? styles.selectedLabel : null}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

// A horizontally scrolling row of chips.
export function ChipRow({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {children}
    </ScrollView>
  );
}
