import {
  fireEvent,
  isHiddenFromAccessibility,
  renderRouter,
  screen,
  waitFor,
} from "expo-router/testing-library";
import { type ComponentType, StrictMode } from "react";

// Renders the real route tree in apps/mobile/app at a starting URL. Strict
// mode runs each effect twice on mount, as development builds do.
export function renderApp(initialUrl: string, { strict = false } = {}) {
  return renderRouter("./app", { initialUrl, ...(strict ? { wrapper: StrictMode } : {}) });
}

type Host = ReturnType<typeof screen.getByText>;

// Under Jest the native tab bar and stack headers render as host views that
// carry their native props, so these helpers read those props.
function hosts(type: string): Host[] {
  return screen.UNSAFE_queryAllByType(type as unknown as ComponentType);
}

// Whether an element sits in the selected tab. iOS shows only that tab; the
// others stay mounted with touches off.
function inSelectedTab(element: Host) {
  for (let node: Host | null = element.parent; node !== null; node = node.parent) {
    if ((node.type as unknown) === "RNSTabsScreenIOS") {
      return node.props.pointerEvents !== "none";
    }
  }
  return true;
}

// The native large-title header with this title, when the person can see it:
// on the top screen of its stack, in the selected tab. iOS gives the
// navigation bar's title the header trait, so VoiceOver reads it as one.
export function queryLargeTitle(title: string): Host | null {
  return (
    hosts("RNSScreenStackHeaderConfig").find(
      (header) =>
        header.props.largeTitle === true &&
        header.props.title === title &&
        !isHiddenFromAccessibility(header) &&
        inSelectedTab(header),
    ) ?? null
  );
}

export function findLargeTitle(title: string) {
  return waitFor(() => {
    const header = queryLargeTitle(title);
    if (header === null) {
      throw new Error(`No large title "${title}" on the screen`);
    }
    return header;
  });
}

// Waits for the inbox: its large "Inbox" title. Tests that only need to know
// the inbox is showing use this instead of matching the inbox's empty-state
// copy, which changes with the inbox's contents.
export function findInbox() {
  return findLargeTitle("Inbox");
}

// The tab bar item with this label, as the native tab bar reports it.
export function tabItem(label: string): Host {
  const item = hosts("RNSTabsScreenIOS").find((tab) => tab.props.title === label);
  if (item === undefined) {
    throw new Error(`No tab labeled "${label}"`);
  }
  return item;
}

function tabBar(): Host {
  const [host] = hosts("RNSTabsHostIOS");
  if (host === undefined) {
    throw new Error("No tab bar on the screen");
  }
  return host;
}

// The label of the tab the tab bar has selected.
export function selectedTab(): string | undefined {
  const key = tabBar().props.navStateRequest.selectedScreenKey;
  return hosts("RNSTabsScreenIOS").find((tab) => tab.props.screenKey === key)?.props.title;
}

export function tabBarHidden(): boolean {
  return tabBar().props.tabBarHidden === true;
}

// Taps a tab bar item: the native tab bar selects the tab and reports the
// selection, as UIKit does when the person taps it.
export function pressTab(label: string) {
  const item = tabItem(label);
  const host = tabBar();
  fireEvent(host, "tabSelected", {
    nativeEvent: {
      selectedScreenKey: item.props.screenKey,
      provenance: host.props.navStateRequest.baseProvenance + 1,
      actionOrigin: "user",
    },
  });
}
