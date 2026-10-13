import { useRef } from "react";
import { Pressable, TextInput, type TextInputProps, View } from "react-native";
import { makeStyles } from "../theme";
import { AppText } from "./text";

const useStyles = makeStyles((theme) => ({
  boxes: { flexDirection: "row", gap: 7, justifyContent: "center" },
  box: {
    alignItems: "center",
    backgroundColor: theme.card,
    borderColor: "transparent",
    borderRadius: 12,
    borderWidth: 2,
    minHeight: 56,
    justifyContent: "center",
    width: 44,
  },
  compact: { borderRadius: 10, minHeight: 50, width: 34 },
  current: { borderColor: theme.accent },
  dash: { alignItems: "center", justifyContent: "center", width: 10 },
  // The real input stays focusable and readable by tests and assistive
  // technology, but draws nothing.
  hidden: { color: "transparent", height: 1, opacity: 0.02, position: "absolute", width: 1 },
}));

// A code typed into one box per character, such as an emailed sign-in code or
// an installer code. One hidden TextInput holds the value, so paste and iOS
// one-time-code autofill work. `groups` splits the boxes with a dash, e.g.
// [4, 4] for XXXX-XXXX. Codes are letters and digits only, so anything else,
// such as the dash in a pasted "ABCD-EFGH", is dropped. Extra characters are
// kept rather than cut, so the screen's own validation refuses a code that is
// too long instead of sending a different one. `onComplete` fires when the
// value is exactly `length` characters.
export function CodeInput({
  length,
  groups,
  value,
  onChangeText,
  onComplete,
  accessibilityLabel,
  editable = true,
  autoFocus = false,
  ...inputProps
}: {
  length: number;
  groups?: number[];
  value: string;
  onChangeText: (text: string) => void;
  onComplete?: (text: string) => void;
  accessibilityLabel: string;
  editable?: boolean;
  autoFocus?: boolean;
} & Pick<TextInputProps, "autoCapitalize" | "autoComplete" | "inputMode" | "textContentType">) {
  const styles = useStyles();
  const input = useRef<TextInput>(null);
  const compact = length > 6;
  const sizes = groups ?? [length];
  let offset = 0;
  return (
    <Pressable accessible={false} onPress={() => input.current?.focus()} style={styles.boxes}>
      {sizes.map((size, group) => {
        const start = offset;
        offset += size;
        return (
          // The boxes only draw the value; VoiceOver reads the hidden input.
          <View
            key={start}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ flexDirection: "row", gap: compact ? 5 : 7 }}
          >
            {group === 0 ? null : (
              <View style={styles.dash}>
                <AppText tone="tertiary">–</AppText>
              </View>
            )}
            {Array.from({ length: size }, (_, i) => {
              const index = start + i;
              const char = value[index] ?? "";
              const current = editable && index === Math.min(value.length, length - 1);
              return (
                <View
                  key={index}
                  style={[styles.box, compact && styles.compact, current && styles.current]}
                >
                  {/* Boxes are a fixed width, so the glyph stops growing at
                      1.4x; the input itself still follows Dynamic Type. */}
                  <AppText
                    variant={compact ? "title3" : "title2"}
                    weight="600"
                    maxFontSizeMultiplier={1.4}
                  >
                    {char}
                  </AppText>
                </View>
              );
            })}
          </View>
        );
      })}
      <TextInput
        ref={input}
        accessibilityLabel={accessibilityLabel}
        autoCorrect={false}
        autoFocus={autoFocus}
        editable={editable}
        onChangeText={(text) => {
          const code = text.replace(/[^0-9A-Za-z]/g, "");
          onChangeText(code);
          if (code.length === length) {
            onComplete?.(code);
          }
        }}
        style={styles.hidden}
        value={value}
        {...inputProps}
      />
    </Pressable>
  );
}
