import { useMutation } from "convex/react";
import { useFocusEffect, useRouter } from "expo-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, AppState, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { decisions } from "../../../convex/decisions/refs";
import { Button } from "./button";
import { answerFailure } from "./decision-errors";
import type { CardDecision } from "./decision-row";
import { haptic } from "./haptics";
import { makeStyles, radius, spacing } from "./theme";
import { AppText } from "./ui/text";

// How long a one-tap answer waits for Undo before it is sent.
export const HOLD_MS = 4000;

// Above this text size a row of controls stacks vertically (Apple HIG
// Typography: layouts adapt to larger Dynamic Type sizes).
export const STACK_FONT_SCALE = 1.35;

export type QuickChoice = "approve" | "reject";

type Held = {
  decision: CardDecision;
  choice: QuickChoice;
  timer: ReturnType<typeof setTimeout>;
};

type QuickAnswers = {
  // Decisions answered from a card: held for Undo, in flight, or sent. Screens
  // leave them out of their lists, so the card goes as soon as it is tapped.
  hidden: ReadonlySet<string>;
  // A failed answer's message, by decision, shown on the restored card.
  failures: ReadonlyMap<string, string>;
  answer: (decision: CardDecision, choice: QuickChoice) => void;
};

const QuickAnswersContext = createContext<QuickAnswers | null>(null);

export function useQuickAnswers(): QuickAnswers {
  const value = useContext(QuickAnswersContext);
  if (value === null) {
    throw new Error("useQuickAnswers needs a QuickAnswerScope");
  }
  return value;
}

function verb(choice: QuickChoice): string {
  return choice === "approve" ? "Approved" : "Rejected";
}

function without<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(item);
  return next;
}

const useStyles = makeStyles((theme) => ({
  // Only `flex: 1`, so the view is layout-only and React Native flattens it:
  // the screen's scroll view stays the screen's first native view, which the
  // native large title tracks as it collapses.
  scope: { flex: 1 },
  dock: { bottom: 0, left: 0, position: "absolute", right: 0 },
  banner: {
    alignItems: "center",
    backgroundColor: theme.cardRaised,
    borderColor: theme.separator,
    borderRadius: radius.control,
    borderWidth: 0.5,
    flexDirection: "row",
    gap: 8,
    marginBottom: 8,
    marginHorizontal: spacing.screen,
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 4,
    shadowColor: "#000000",
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
  },
  stacked: { alignItems: "stretch", flexDirection: "column", paddingRight: 16, paddingTop: 12 },
  message: { flex: 1 },
  stackedMessage: { flex: 0 },
}));

// The Undo banner at the bottom of the screen. The safe area inside a tab
// includes the tab bar, so the banner sits above it.
function UndoBanner({ held, onUndo }: { held: Omit<Held, "timer">; onUndo: () => void }) {
  const styles = useStyles();
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > STACK_FONT_SCALE;
  const message = `${verb(held.choice)} “${held.decision.title}”`;
  return (
    <SafeAreaView edges={["bottom"]} pointerEvents="box-none" style={styles.dock}>
      <View
        accessibilityLiveRegion="polite"
        testID="undo-banner"
        style={[styles.banner, stacked && styles.stacked]}
      >
        <AppText variant="subhead" style={stacked ? styles.stackedMessage : styles.message}>
          {message}
        </AppText>
        <Button
          label="Undo"
          accessibilityHint={`Puts “${held.decision.title}” back without answering it`}
          variant="plain"
          size="small"
          onPress={onUndo}
        />
      </View>
    </SafeAreaView>
  );
}

// One-tap Approve and Reject for the decision cards on a screen, with Undo
// (Apple HIG Feedback: confirm an action without interrupting the person, and
// let them undo it, rather than asking first in an alert). A tap hides the
// card at once and shows "Approved “title”" with Undo above the tab bar; the
// `decisions/app:answer` call goes out after HOLD_MS, once, never retried.
// Undo before then cancels it and restores the card. The held answer is sent
// at once, so it is never lost, when the screen loses focus or unmounts, when
// the app leaves the foreground, when another card is answered, or when the
// decision's deadline falls within the hold. A sent answer confirms with a
// success haptic. A `conflict` means the decision settled elsewhere first:
// the card comes back and the decision screen opens on the recorded outcome
// (req-mobile-app AC-3.2), unless the person has left this screen. Any other
// failure restores the card with the message, an error haptic, and a
// VoiceOver announcement.
export function QuickAnswerScope({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const router = useRouter();
  const mutate = useMutation(decisions.app.answer);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [banner, setBanner] = useState<Omit<Held, "timer"> | null>(null);
  // Refs, so a second tap before the re-render is refused and the focus and
  // app-state handlers below stay the same across renders.
  const held = useRef<Held | null>(null);
  const answered = useRef(new Set<string>());
  const focused = useRef(true);
  const latest = useRef({ mutate, router });
  latest.current = { mutate, router };

  const restore = useCallback((id: string) => {
    answered.current.delete(id);
    setHidden((current) => without(current, id));
  }, []);

  const send = useCallback(
    (decision: CardDecision, choice: QuickChoice) => {
      latest.current.mutate({ decisionId: decision.id, answer: { kind: choice } }).then(
        // The decision stays hidden: the pending list drops it as the answer
        // commits.
        () => void haptic.success(),
        (error: unknown) => {
          restore(decision.id);
          const result = answerFailure(error);
          if (result.kind === "failed") {
            setFailures((current) => new Map(current).set(decision.id, result.message));
            void haptic.error();
            AccessibilityInfo.announceForAccessibility(result.message);
          } else if (focused.current) {
            latest.current.router.push({
              pathname: "/decision/[id]",
              params: { id: decision.id },
            });
          }
        },
      );
    },
    [restore],
  );

  const flush = useCallback(() => {
    const current = held.current;
    if (current === null) {
      return;
    }
    clearTimeout(current.timer);
    held.current = null;
    setBanner(null);
    send(current.decision, current.choice);
  }, [send]);

  const answer = useCallback(
    (decision: CardDecision, choice: QuickChoice) => {
      if (answered.current.has(decision.id)) {
        return;
      }
      flush();
      answered.current.add(decision.id);
      setHidden((current) => new Set(current).add(decision.id));
      setFailures((current) => {
        const next = new Map(current);
        next.delete(decision.id);
        return next;
      });
      const { deadline } = decision;
      if (deadline !== null && Date.parse(deadline) - Date.now() <= HOLD_MS) {
        send(decision, choice);
        return;
      }
      const timer = setTimeout(flush, HOLD_MS);
      held.current = { decision, choice, timer };
      setBanner({ decision, choice });
      AccessibilityInfo.announceForAccessibility(
        `${verb(choice)} “${decision.title}”. Undo available.`,
      );
    },
    [flush, send],
  );

  const undo = useCallback(() => {
    const current = held.current;
    if (current === null) {
      return;
    }
    clearTimeout(current.timer);
    held.current = null;
    setBanner(null);
    restore(current.decision.id);
    AccessibilityInfo.announceForAccessibility(`Undone. “${current.decision.title}” is back.`);
  }, [restore]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        flush();
      };
    }, [flush]),
  );

  // "inactive" too: from the app switcher the app can be closed without ever
  // reaching the background.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        flush();
      }
    });
    return () => subscription.remove();
  }, [flush]);

  return (
    <QuickAnswersContext.Provider value={{ hidden, failures, answer }}>
      <View style={styles.scope}>
        {children}
        {banner === null ? null : <UndoBanner held={banner} onUndo={undo} />}
      </View>
    </QuickAnswersContext.Provider>
  );
}
