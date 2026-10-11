import { StyleSheet } from "react-native";

// Shared styles for the shell's screens.
export const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  screen: { flex: 1, gap: 16, padding: 24 },
  title: { fontSize: 22, fontWeight: "600", textAlign: "center" },
  body: { fontSize: 16, textAlign: "center" },
  code: { fontFamily: "Courier", fontSize: 14 },
  error: { color: "#b3261e", fontSize: 15 },
  input: {
    borderColor: "#8a8a8a",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  button: { alignItems: "center", backgroundColor: "#1f5fbf", borderRadius: 8, padding: 14 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#ffffff", fontSize: 17, fontWeight: "600" },
  link: { color: "#1f5fbf", fontSize: 16, padding: 6 },
  headerLinks: { flexDirection: "row", gap: 4 },
});
