import { useColorScheme } from "react-native";

// Quiet greys, light and dark. The one accent is kept for Needs you: nothing else uses it.
const light = { bg: "#fbfbfa", text: "#1c1c1b", muted: "#6b6a66", rule: "#e4e3df", bar: "#f1f0ed", accent: "#2f5bd3" };
const dark = { bg: "#141413", text: "#ecebe7", muted: "#9b9a95", rule: "#2b2b29", bar: "#1e1e1c", accent: "#8aa8ff" };

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
