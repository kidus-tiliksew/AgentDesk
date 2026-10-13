import { useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { radius, type Theme, useTheme } from "./theme";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

// The library's defaults are light-scheme greys (#F5F5F5 code, #000 rules),
// so every colored rule is set from the theme for both schemes. A settled
// decision's body reads in the secondary color (prototype "Decision:
// settled").
function markdownStyles(theme: Theme, muted: boolean) {
  const code = {
    backgroundColor: theme.fill,
    borderWidth: 0,
    borderRadius: 6,
    color: theme.text,
    fontFamily: mono,
    fontSize: 14,
  };
  return StyleSheet.create({
    body: { color: muted ? theme.textSecondary : theme.text, fontSize: 16, lineHeight: 23 },
    paragraph: { marginBottom: 10, marginTop: 0 },
    heading1: { fontSize: 22, fontWeight: "700", marginBottom: 6 },
    heading2: { fontSize: 19, fontWeight: "700", marginBottom: 6 },
    heading3: { fontSize: 17, fontWeight: "600", marginBottom: 4 },
    link: { color: theme.accent, textDecorationLine: "none" },
    code_inline: { ...code, paddingHorizontal: 4 },
    code_block: { ...code, borderRadius: radius.small, padding: 10, marginBottom: 10 },
    fence: { ...code, borderRadius: radius.small, padding: 10, marginBottom: 10 },
    blockquote: {
      backgroundColor: theme.fill,
      borderColor: theme.accent,
      borderLeftWidth: 3,
      borderRadius: 4,
      marginLeft: 0,
      marginBottom: 10,
      paddingHorizontal: 10,
    },
    hr: { backgroundColor: theme.separator, height: StyleSheet.hairlineWidth, marginVertical: 10 },
    table: { borderColor: theme.separator, borderRadius: 6, marginBottom: 10 },
    thead: { backgroundColor: theme.fill },
    tr: { borderColor: theme.separator },
  });
}

// A decision's body rendered as Markdown (req-mobile-app AC-3.1).
export function DecisionBody({ body, muted }: { body: string; muted: boolean }) {
  const theme = useTheme();
  const style = useMemo(() => markdownStyles(theme, muted), [theme, muted]);
  return (
    <View style={{ paddingHorizontal: 20 }}>
      <Markdown style={style}>{body}</Markdown>
    </View>
  );
}
