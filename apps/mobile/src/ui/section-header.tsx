import { View } from "react-native";
import { AppText } from "./text";

// A bold section title with an optional count or note on the right.
export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  return (
    <View
      style={{
        alignItems: "baseline",
        flexDirection: "row",
        justifyContent: "space-between",
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 8,
      }}
    >
      <AppText accessibilityRole="header" variant="title3" weight="700">
        {title}
      </AppText>
      {detail === undefined ? null : (
        <AppText variant="subhead" tone="secondary">
          {detail}
        </AppText>
      )}
    </View>
  );
}
