import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";

export type IconName = ComponentProps<typeof Ionicons>["name"];

// An Ionicons glyph. Decorative by default: the surrounding control carries
// the accessible label.
export function Icon({
  name,
  size = 20,
  color,
}: {
  name: IconName;
  size?: number;
  color: ColorValue;
}) {
  return (
    <Ionicons
      name={name}
      size={size}
      color={color}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
