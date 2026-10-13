import { Pressable, View } from "react-native";
import { haptic } from "../haptics";
import { makeStyles, spacing } from "../theme";
import { AppText } from "./text";

const useStyles = makeStyles((theme) => ({
  track: {
    backgroundColor: theme.fill,
    borderRadius: 9,
    flexDirection: "row",
    marginHorizontal: spacing.screen,
    padding: 2,
  },
  segment: { alignItems: "center", borderRadius: 7, flex: 1, paddingVertical: 6 },
  selected: {
    backgroundColor: theme.scheme === "dark" ? theme.cardRaised : theme.card,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 3,
  },
}));

// An iOS segmented control: one option of a few is selected.
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string; accessibilityLabel?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const styles = useStyles();
  return (
    <View accessibilityRole="tablist" style={styles.track}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected }}
            // Segments draw about 32 pt tall, like the system control; the
            // slop makes each hit region 44 pt (Apple HIG Buttons).
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => {
              if (!selected) {
                haptic.selection();
              }
              onChange(option.value);
            }}
            style={[styles.segment, selected && styles.selected]}
          >
            <AppText variant="footnote" weight={selected ? "600" : "500"}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
