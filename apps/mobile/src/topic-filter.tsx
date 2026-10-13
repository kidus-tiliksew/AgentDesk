import { Chip, ChipRow } from "./ui/chip";

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
    <ChipRow>
      <Chip label="All topics" selected={selected === null} onPress={() => onSelect(null)} />
      {chips.map((chip) => (
        <Chip
          key={chip}
          label={chip}
          accessibilityLabel={`Topic: ${chip}`}
          selected={selected === chip}
          onPress={() => onSelect(chip)}
        />
      ))}
    </ChipRow>
  );
}
