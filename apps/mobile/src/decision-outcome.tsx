import type { Answer, AnsweredVia, Decision, Option } from "@agentdesk/contract";
import { View } from "react-native";
import { makeStyles, radius, spacing, type Theme, tint, useTheme } from "./theme";
import { Card } from "./ui/card";
import { Icon, type IconName } from "./ui/icon";
import { AppText } from "./ui/text";

// An option's label, or its id when the decision has no such option.
function optionLabel(options: readonly Option[] | null, id: string) {
  return options?.find((option) => option.id === id)?.label ?? id;
}

// An answer as the user reads it: Approve or Reject, option labels, or the
// text itself. src/decision-detail.tsx re-exports it under its old name.
export function formatAnswer(answer: Answer, options: readonly Option[] | null): string {
  switch (answer.kind) {
    case "approve":
      return "Approve";
    case "reject":
      return "Reject";
    case "option":
      return optionLabel(options, answer.option_id);
    case "options":
      return answer.option_ids.map((id) => optionLabel(options, id)).join(", ");
    case "text":
      return answer.text;
  }
}

// A time on the decision screen: the clock time with "Today" or "Yesterday",
// or the date as well when older. Settled times keep their minute, since
// when an answer landed can matter to the user (design brief: absolute where
// precision matters).
export function formatWhen(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  if (days === 0) {
    return `Today ${time}`;
  }
  if (days === 1) {
    return `Yesterday ${time}`;
  }
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  const date = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}

export type OutcomeTone = "accent" | "green" | "grey";

// How a decision stands, in one word or two, with the color and glyph the
// design gives it: green answered, accent default applied, grey expired or
// cancelled (prototype "Decision: settled"). A pending decision reads as
// Pending, for the follow-up rows that list one.
export function outcomeOf(decision: Decision): {
  title: string;
  tone: OutcomeTone;
  icon: IconName;
} {
  switch (decision.state) {
    case "pending":
      return { title: "Pending", tone: "accent", icon: "time-outline" };
    case "answered":
      if (decision.answer?.kind === "approve") {
        return { title: "Approved", tone: "green", icon: "checkmark-circle" };
      }
      if (decision.answer?.kind === "reject") {
        return { title: "Rejected", tone: "green", icon: "close-circle" };
      }
      return { title: "Answered", tone: "green", icon: "checkmark-circle" };
    case "expired":
      return decision.applied_by_default
        ? { title: "Default applied", tone: "accent", icon: "timer-outline" }
        : { title: "Expired", tone: "grey", icon: "hourglass-outline" };
    case "cancelled":
      return { title: "Cancelled", tone: "grey", icon: "remove-circle-outline" };
  }
}

export function outcomeColor(theme: Theme, tone: OutcomeTone): string {
  return theme[tone];
}

// Who or what settled the decision, from `answered_via`.
function surface(via: AnsweredVia): string {
  switch (via) {
    case "app":
      return "By you in the app";
    case "notification":
      return "By you from a notification";
    case "api":
      return "Through the API";
    case "chat":
      return "Answered in chat";
    case "default":
      return "Applied at the deadline";
  }
}

const useStyles = makeStyles(() => ({
  banner: {
    alignItems: "flex-start",
    borderRadius: radius.card - 2,
    flexDirection: "row",
    gap: 10,
    marginHorizontal: spacing.screen,
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  bannerText: { flex: 1, gap: 2 },
  note: { marginTop: 10 },
}));

// What the banner says, as lines: the outcome, the answer when the title
// alone does not say it, and how and when the decision was settled.
function outcomeLines(decision: Decision, now: number) {
  const outcome = outcomeOf(decision);
  const { answer } = decision;
  let detail: string | null = null;
  if (answer === null) {
    detail = decision.state === "expired" ? "Expired without an answer" : "No answer was recorded.";
  } else if (
    decision.applied_by_default ||
    (answer.kind !== "approve" && answer.kind !== "reject")
  ) {
    // "Approved" and "Rejected" name the answer; any other title does not.
    detail = formatAnswer(answer, decision.options);
  }
  const how = [
    decision.answered_via === null ? null : surface(decision.answered_via),
    decision.answered_at === null ? null : formatWhen(decision.answered_at, now),
  ].filter((part) => part !== null);
  return { outcome, detail, how };
}

// The recorded outcome as one sentence for VoiceOver: the banner's label, and
// what the decision screen announces when an answer arrives too late
// (req-mobile-app AC-3.2).
export function describeOutcome(decision: Decision, now: number): string {
  const { outcome, detail, how } = outcomeLines(decision, now);
  return [outcome.title, detail, how.length === 0 ? null : how.join(", ")]
    .filter((part) => part !== null)
    .map((part) => part.replace(/\.$/, ""))
    .join(". ");
}

// A settled decision's recorded outcome, read-only: a colored banner naming
// the outcome, the answer when the title alone does not say it, how and when
// it was settled, and the note in a card (req-decision-requests REQ-4,
// AC-4.3, AC-5.1, AC-5.2). Answered, expired with its default applied,
// expired without an answer, and cancelled each read differently. Apple HIG
// VoiceOver: the banner is one header element whose label reads all of it,
// so the outcome is never split across swipes and the headings rotor finds
// it.
export function SettledOutcome({ decision, now }: { decision: Decision; now: number }) {
  const styles = useStyles();
  const theme = useTheme();
  const { outcome, detail, how } = outcomeLines(decision, now);
  const color = outcomeColor(theme, outcome.tone);
  return (
    <View>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={describeOutcome(decision, now)}
        style={[
          styles.banner,
          { backgroundColor: tint(color, theme.scheme === "dark" ? 0.2 : 0.14) },
        ]}
      >
        <Icon name={outcome.icon} size={22} color={color} />
        <View style={styles.bannerText}>
          <AppText variant="callout" weight="700">
            {outcome.title}
          </AppText>
          {detail === null ? null : (
            <AppText variant="subhead" weight="600">
              {detail}
            </AppText>
          )}
          {how.length === 0 ? null : (
            <AppText variant="footnote" tone="secondary">
              {how.join(" · ")}
            </AppText>
          )}
        </View>
      </View>
      {decision.note === null ? null : (
        <Card style={styles.note}>
          <AppText variant="footnote" tone="secondary">
            Note
          </AppText>
          <AppText>{decision.note}</AppText>
        </Card>
      )}
    </View>
  );
}
