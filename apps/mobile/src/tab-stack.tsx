import { useIsFocused } from "expo-router";
import { useState } from "react";

// Options every tab's stack shares. The back button shows only its chevron;
// the stack still passes the previous screen's title to iOS, so a long press
// on the back button lists the real screen names.
export const tabStackOptions = {
  headerBackButtonDisplayMode: "minimal",
} as const;

// A tab root's header: the iOS large title, which collapses into the
// navigation bar as the screen's scroll view scrolls. React Navigation makes
// a large-title header translucent on iOS, so the bar takes the system
// material (Liquid Glass on iOS 26) instead of a solid color.
export function largeTitleOptions(title: string) {
  return { title, headerLargeTitleEnabled: true } as const;
}

// Native tabs render every tab's screen as soon as the tab bar mounts. A tab's
// stack calls this and renders nothing until the tab is first selected, so a
// tab's screens and their queries start when the person opens the tab, as
// with a lazy JavaScript tab navigator. Once shown, the stack stays mounted.
export function useTabVisited() {
  const focused = useIsFocused();
  const [visited, setVisited] = useState(focused);
  if (focused && !visited) {
    setVisited(true);
  }
  return visited || focused;
}
