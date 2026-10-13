import type { Decision } from "@agentdesk/contract";
import { useRouter } from "expo-router";
import { Pressable, useWindowDimensions, View } from "react-native";
import { Button } from "./button";
import { formatAnswer } from "./decision-outcome";
import { type QuickChoice, STACK_FONT_SCALE, useQuickAnswers } from "./inbox-undo";
import { makeStyles, useTheme } from "./theme";
import { Card } from "./ui/card";
import { Icon } from "./ui/icon";
import { Pill } from "./ui/pill";
import { AppText } from "./ui/text";

export function formatDeadline(deadline: string | null): string {
  return deadline === null ? "No deadline" : `Due ${new Date(deadline).toLocaleString()}`;
}

// A deadline counts as close, and its pill turns red, under five minutes.
const CLOSE_MS = 5 * 60_000;

// Time left until `deadline` from `now`, in minutes or coarser: a card is read
// at a glance, so it does not tick every second. The decision screen shows the
// exact deadline. The label only presents the device clock: the backend alone
// expires a decision (req-decision-requests REQ-5).
export function formatTimeLeft(deadline: string, now: number): string {
  const left = Date.parse(deadline) - now;
  if (left <= 0) {
    return "Deadline passed";
  }
  const minutes = Math.floor(left / 60_000);
  if (minutes < 1) {
    return "Under 1m left";
  }
  if (minutes < 60) {
    return `${minutes}m left`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}h left` : `${hours}h ${minutes % 60}m left`;
  }
  return `${Math.floor(hours / 24)}d left`;
}

// What kind of answer a decision wants, for VoiceOver.
function inputHint(decision: CardDecision): string | null {
  const count = decision.options?.length ?? 0;
  switch (decision.input_type) {
    case "approve_reject":
      return "Approve or reject";
    case "single_choice":
      return `Choose one of ${count} options`;
    case "multiple_choice":
      return `Choose any of ${count} options`;
    case "free_text":
      return "Written answer";
    case "single_choice_or_text":
      return `Choose one of ${count} options or write an answer`;
    default:
      return null;
  }
}

// The fields a card shows. A full Decision has them all; a digest's summary of
// a decision lacks the input type, options, and recommendation, and its card
// then offers no one-tap answer.
export type CardDecision = Pick<Decision, "id" | "title" | "topic" | "priority" | "deadline"> &
  Partial<Pick<Decision, "input_type" | "options" | "recommendation">>;

const useStyles = makeStyles(() => ({
  body: { gap: 6 },
  pressed: { opacity: 0.7 },
  recommendation: { alignItems: "center", flexDirection: "row", gap: 5, marginTop: 2 },
  actions: { flexDirection: "row", gap: 8, marginTop: 6 },
  stacked: { flexDirection: "column" },
}));

// One-tap Reject and Approve for an approve/reject decision. The recommended
// choice is the filled button with the sparkles icon (req-mobile-app AC-3.3);
// the other is secondary, as on the decision screen. The screen's
// QuickAnswerScope holds the answer for Undo and sends it; a failure comes
// back here as the card returns. At large text sizes the buttons stack, so
// neither label is cut short.
function QuickAnswer({ decision }: { decision: CardDecision }) {
  const styles = useStyles();
  const { answer, failures } = useQuickAnswers();
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > STACK_FONT_SCALE;
  const failure = failures.get(decision.id) ?? null;
  const recommended = decision.recommendation?.kind;

  const button = (choice: QuickChoice, label: string) => (
    <Button
      label={label}
      accessibilityLabel={`${label}: ${decision.title}`}
      accessibilityHint={recommended === choice ? "Recommended by the agent" : undefined}
      variant={recommended === choice ? "primary" : "secondary"}
      icon={recommended === choice ? "sparkles" : undefined}
      size="small"
      grow={!stacked}
      onPress={() => answer(decision, choice)}
    />
  );

  return (
    <>
      <View style={[styles.actions, stacked && styles.stacked]}>
        {button("reject", "Reject")}
        {button("approve", "Approve")}
      </View>
      {failure === null ? null : (
        <AppText variant="footnote" tone="red">
          {failure}
        </AppText>
      )}
    </>
  );
}

// What VoiceOver reads after a card's title: every fact about the decision,
// including the input type and recommendation the card does not draw, so the
// card is understood without exploring its parts (Apple HIG Accessibility:
// describe an element fully, not only by its name).
function cardDescription(decision: CardDecision, agentName: string | null, now: number): string {
  return [
    decision.priority === "urgent" ? "Urgent" : null,
    decision.deadline === null ? "No deadline" : formatTimeLeft(decision.deadline, now),
    agentName,
    `Topic ${decision.topic}`,
    inputHint(decision),
    decision.recommendation == null
      ? null
      : `Recommends ${formatAnswer(decision.recommendation, decision.options ?? null)}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

// The card's one pill: urgency and time left together ("Urgent · 4m left"),
// red when urgent or under five minutes. A normal decision without a deadline
// has none.
function UrgencyPill({ decision, now }: { decision: CardDecision; now: number }) {
  const { deadline } = decision;
  const urgent = decision.priority === "urgent";
  if (!urgent && deadline === null) {
    return null;
  }
  const left = deadline === null ? null : formatTimeLeft(deadline, now);
  const close = deadline !== null && Date.parse(deadline) - now < CLOSE_MS;
  return (
    <Pill
      label={urgent ? (left === null ? "Urgent" : `Urgent · ${left}`) : (left ?? "")}
      tone={urgent || close ? "red" : "neutral"}
      icon={urgent ? "flash" : "time-outline"}
    />
  );
}

// A pending decision as a card: at most one pill for urgency and time left,
// the title, and "agent · topic". A decision without one-tap buttons also
// shows the agent's recommendation; on an approve/reject card the sparkles on
// the recommended button shows it. VoiceOver reads every fact, drawn or not,
// as the card's value. Pressing the body opens the decision screen; an
// approve/reject decision also answers from the card, and its buttons stay
// separate VoiceOver elements. `agentName` is null when the caller cannot
// name the decision's agent. A card sits inside a QuickAnswerScope.
export function DecisionCard({
  decision,
  agentName,
  now,
  accessibilityLabel,
}: {
  decision: CardDecision;
  agentName: string | null;
  now: number;
  accessibilityLabel?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const { recommendation } = decision;
  const quick = decision.input_type === "approve_reject";
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? `Decision: ${decision.title}`}
        accessibilityValue={{ text: cardDescription(decision, agentName, now) }}
        onPress={() => router.push({ pathname: "/decision/[id]", params: { id: decision.id } })}
        style={({ pressed }) => [styles.body, pressed && styles.pressed]}
      >
        <UrgencyPill decision={decision} now={now} />
        <AppText variant="headline">{decision.title}</AppText>
        <AppText variant="footnote" tone="secondary">
          {agentName === null ? decision.topic : `${agentName} · ${decision.topic}`}
        </AppText>
        {quick || recommendation == null ? null : (
          <View style={styles.recommendation}>
            <Icon name="sparkles" size={14} color={theme.accent} />
            <AppText variant="footnote" tone="secondary">
              Recommends{" "}
              <AppText variant="footnote" weight="600">
                {formatAnswer(recommendation, decision.options ?? null)}
              </AppText>
            </AppText>
          </View>
        )}
      </Pressable>
      {quick ? <QuickAnswer decision={decision} /> : null}
    </Card>
  );
}
