import { Pressable, ScrollView, Text } from "react-native";
import { styles } from "./styles";

function Chip({
  label,
  accessibilityLabel,
  selected,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={selected ? styles.chipTextSelected : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

// "All topics" and one chip per topic. One chip is selected at a time;
// `selected` null means All topics.
export function TopicFilter({
  chips,
  selected,
  onSelect,
}: {
  chips: string[];
  selected: string | null;
  onSelect: (topic: string | null) => void;
}) {
  return (
    <ScrollView horizontal contentContainerStyle={styles.chips}>
      <Chip
        label="All topics"
        accessibilityLabel="All topics"
        selected={selected === null}
        onPress={() => onSelect(null)}
      />
      {chips.map((chip) => (
        <Chip
          key={chip}
          label={chip}
          accessibilityLabel={`Topic: ${chip}`}
          selected={selected === chip}
          onPress={() => onSelect(chip)}
        />
      ))}
    </ScrollView>
  );
}
