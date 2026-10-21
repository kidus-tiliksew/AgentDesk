import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { screen as appScreen } from "expo-router/testing-library";
import {
  KeyboardAvoidingView,
  Platform,
  type StyleProp,
  StyleSheet,
  type ViewStyle,
} from "react-native";
import { Button } from "../src/button";
import { linkHitSlop, minTouchTarget, placeholderOnFill, themes } from "../src/theme";
import { Chip } from "../src/ui/chip";
import { GroupedRow } from "../src/ui/grouped";
import { SegmentedControl } from "../src/ui/segmented";
import { agent, decision } from "./data";
import { setQuery, signInAs } from "./fakes";
import { findInbox, renderApp } from "./render";

// DEC-17(2) and DEC-17(4) on Android: 48x48 dp touch targets, 4.5:1
// placeholder text on filled fields, and keyboard avoidance that does not rely
// on the window resizing, which edge-to-edge drawing turns off. iOS keeps its
// 44 pt targets and colors.

type Os = "ios" | "android";

function on(os: Os) {
  jest.replaceProperty(Platform, "OS", os);
}

function minHeight(element: { props: { style?: StyleProp<ViewStyle> } }) {
  return StyleSheet.flatten(element.props.style)?.minHeight;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("touch target helpers", () => {
  test.each([
    ["ios", 44, 12],
    ["android", 48, 14],
  ] as const)(
    "on %s the smallest target is %i and a text link's slop is %i",
    (os, target, slop) => {
      on(os);
      expect(minTouchTarget()).toBe(target);
      expect(linkHitSlop()).toEqual({ top: slop, bottom: slop, left: 8, right: 8 });
    },
  );

  test("a filled field's placeholder darkens only in Android's light scheme", () => {
    on("android");
    expect(placeholderOnFill(themes.light)).toBe(themes.lightHigh.textSecondary);
    expect(placeholderOnFill(themes.dark)).toBe(themes.dark.textSecondary);
    expect(placeholderOnFill(themes.lightHigh)).toBe(themes.lightHigh.textSecondary);
    on("ios");
    expect(placeholderOnFill(themes.light)).toBe(themes.light.textSecondary);
  });
});

describe("shared controls", () => {
  test.each([
    ["ios", 44, 5, 6, 46],
    ["android", 48, 7, 9, 48],
  ] as const)(
    "on %s: small button %i, chip slop %i, segment slop %i, row %i",
    (os, button, chip, segment, row) => {
      on(os);
      render(
        <>
          <Button label="Retry" size="small" onPress={() => {}} />
          <Chip label="acme" selected={false} onPress={() => {}} />
          <SegmentedControl
            options={[
              { value: "a", label: "All" },
              { value: "b", label: "Answered" },
            ]}
            value="a"
            onChange={() => {}}
          />
          <GroupedRow title="Sign out" onPress={() => {}} />
        </>,
      );

      expect(minHeight(screen.getByRole("button", { name: "Retry" }))).toBe(button);
      expect(screen.getByRole("button", { name: "acme" }).props.hitSlop).toEqual({
        top: chip,
        bottom: chip,
      });
      expect(screen.getByRole("tab", { name: "Answered" }).props.hitSlop).toEqual({
        top: segment,
        bottom: segment,
      });
      expect(minHeight(screen.getByRole("button", { name: "Sign out" }))).toBe(row);
    },
  );
});

describe("screens on Android", () => {
  beforeEach(() => {
    on("android");
  });

  test("sign-in pads for the keyboard and its Privacy Policy link reaches 48 dp", async () => {
    renderApp("/sign-in");

    const link = await appScreen.findByRole("link", { name: "Privacy Policy" });

    expect(link.props.hitSlop).toEqual({ top: 14, bottom: 14, left: 8, right: 8 });
    expect(appScreen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe("padding");
    // TalkBack reads the placeholder in place of the label, then the hint.
    expect(appScreen.getByLabelText("Email address").props.accessibilityHint).toBe(
      "Your email address",
    );
  });

  test("an inbox card's button is at least 48 dp tall", async () => {
    setQuery("decisions/app:listPending", [
      decision({ id: "d_1", title: "Name the branch", input_type: "free_text" }),
    ]);
    signInAs("sess_a");
    renderApp("/");
    await findInbox();

    const card = await appScreen.findByRole("button", { name: "Decision: Name the branch" });

    expect(minHeight(card)).toBe(48);
  });

  test("the decision screen pads its dock for the keyboard and the note link reaches 48 dp", async () => {
    setQuery("decisions/app:get", (args: { decisionId: string }) =>
      decision({ id: args.decisionId, title: "Drop the column?" }),
    );
    setQuery("agents/app:get", (args: { agentSessionId: string }) => ({
      ...agent({ id: args.agentSessionId }),
      history: [],
      pending_decisions: [],
    }));
    signInAs("sess_a");
    renderApp("/decision/d_1");

    const note = await appScreen.findByRole("button", { name: "Add note" });

    expect(note.props.hitSlop).toEqual({ top: 14, bottom: 14, left: 8, right: 8 });
    // A text's accessibility value would replace the title for TalkBack.
    expect(
      appScreen.getByRole("header", { name: /^Drop the column\?, (Urgent|Normal) priority$/ }),
    ).toBeOnTheScreen();
    expect(appScreen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe("padding");
    act(() => fireEvent.press(note));
    expect(appScreen.getByLabelText("Note").props.placeholderTextColor).toBe(
      themes.lightHigh.textSecondary,
    );
  });
});
