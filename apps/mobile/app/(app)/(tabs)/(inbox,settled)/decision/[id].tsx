import { type AnswerSubmission, errorCodeSchema } from "@agentdesk/contract";
import { useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { type ReactNode, useRef, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { decisions } from "../../../../../../../convex/decisions/refs";
import { Button } from "../../../../../src/button";
import { AnswerForm } from "../../../../../src/decision-answer-form";
import { DecisionDetail } from "../../../../../src/decision-detail";
import { answerFailure } from "../../../../../src/decision-errors";
import {
  type AppDecision,
  describeOutcome,
  SettledOutcome,
} from "../../../../../src/decision-outcome";
import { haptic } from "../../../../../src/haptics";
import { Loading } from "../../../../../src/loading";
import { errorData, QueryErrorBoundary } from "../../../../../src/query-error-boundary";
import { makeStyles, radius, spacing, tint, useTheme } from "../../../../../src/theme";
import { EmptyState } from "../../../../../src/ui/empty-state";
import { Icon } from "../../../../../src/ui/icon";
import { StackScreen } from "../../../../../src/ui/screen";
import { AppText } from "../../../../../src/ui/text";
import { useScreenClock } from "../../../../../src/use-screen-clock";

// component-mobile-app §Screens: one decision, its details, and the answer
// controls for its input type (req-mobile-app REQ-3). The answer goes through
// `decisions/app:answer`, which records `answeredVia: "app"`. A pending
// decision scrolls above a dock of answer controls; a settled one opens on
// its outcome banner (prototype "Decision" frames).

const useStyles = makeStyles((theme) => ({
  screen: { backgroundColor: theme.background, flex: 1 },
  centered: { backgroundColor: theme.background, flex: 1, justifyContent: "center" },
  notice: {
    alignItems: "flex-start",
    backgroundColor: tint(theme.red, theme.scheme === "dark" ? 0.2 : 0.12),
    borderRadius: radius.control,
    flexDirection: "row",
    gap: 8,
    marginHorizontal: spacing.screen,
    marginTop: 6,
    padding: 12,
  },
  noticeText: { flex: 1 },
}));

// A red notice above the decision, for an answer that was not recorded.
function Notice({ children }: { children: string }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Icon name="alert-circle" size={18} color={theme.red} />
      <AppText variant="subhead" tone="red" style={styles.noticeText}>
        {children}
      </AppText>
    </View>
  );
}

function NotFound() {
  const styles = useStyles();
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: "Decision" }} />
      <EmptyState
        icon="help-circle-outline"
        title="Decision not found"
        body="This decision does not exist or is not yours."
      />
    </View>
  );
}

// `decisions/app:get` refuses a missing and a foreign decision alike as
// `not_found`, and a malformed id as `invalid` naming `decisionId`. Both show
// the not-found state. Any other failure offers a retry of the query.
function isNotFound(error: unknown) {
  const data = errorData(error);
  return (
    data !== null &&
    (data.code === errorCodeSchema.enum.not_found ||
      (data.code === errorCodeSchema.enum.invalid && data.field === "decisionId"))
  );
}

const CONFLICT_NOTICE =
  "This decision was settled before your answer arrived. Your answer was not recorded.";
const UNREADABLE_NOTICE =
  "This decision was settled elsewhere. Its recorded outcome appears here once it loads.";

function DecisionView({ id }: { id: string }) {
  const styles = useStyles();
  const queried = useQuery(decisions.app.get, { decisionId: id });
  const answer = useMutation(decisions.app.answer);
  const now = useScreenClock();
  // A settled decision the mutation returned, from success or from a
  // `conflict`. It stands in for the query until the subscription reports
  // the settlement, so the form never comes back for a settled decision.
  const [returned, setReturned] = useState<AppDecision | null>(null);
  const [conflicted, setConflicted] = useState(false);
  // A `conflict` without a readable stored decision: no outcome is shown and
  // no answer can be sent until the query reports the settlement.
  const [unreadable, setUnreadable] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set synchronously, so a second press before the re-render sends nothing.
  const inFlight = useRef(false);

  if (queried === undefined) {
    return <Loading label="Loading decision" />;
  }
  const decision = queried.state === "pending" && returned !== null ? returned : queried;

  // One request per press, never retried automatically. A `conflict` drops
  // the attempt and shows the stored outcome (req-mobile-app AC-3.2); any
  // other failure keeps the draft for a deliberate retry. Apple HIG Playing
  // haptics: a success haptic confirms the answer was recorded and an error
  // haptic marks one that was not. Apple HIG VoiceOver: the outcome of a
  // failed answer is announced, since the notice appears away from the
  // button the person pressed.
  const submit = (submission: AnswerSubmission) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setFailure(null);
    answer({
      decisionId: id,
      answer: submission.answer,
      ...(submission.note === undefined ? {} : { note: submission.note }),
    })
      .then(
        (settled) => {
          haptic.success();
          setReturned(settled);
        },
        (error: unknown) => {
          haptic.error();
          const result = answerFailure(error);
          if (result.kind === "conflict") {
            setReturned(result.decision);
            setConflicted(true);
            AccessibilityInfo.announceForAccessibility(
              `${CONFLICT_NOTICE} Recorded outcome: ${describeOutcome(result.decision, Date.now())}.`,
            );
          } else if (result.kind === "malformed_conflict") {
            setUnreadable(true);
            AccessibilityInfo.announceForAccessibility(UNREADABLE_NOTICE);
          } else {
            setFailure(result.message);
            AccessibilityInfo.announceForAccessibility(result.message);
          }
        },
      )
      .finally(() => {
        inFlight.current = false;
        setSubmitting(false);
      });
  };

  const detail = <DecisionDetail decision={decision} now={now} />;
  let content: ReactNode;
  if (decision.state !== "pending") {
    content = (
      <StackScreen>
        {conflicted ? <Notice>{CONFLICT_NOTICE}</Notice> : null}
        <SettledOutcome decision={decision} now={now} />
        {detail}
      </StackScreen>
    );
  } else if (unreadable) {
    content = (
      <StackScreen>
        <Notice>{UNREADABLE_NOTICE}</Notice>
        {detail}
      </StackScreen>
    );
  } else {
    content = (
      <AnswerForm decision={decision} submitting={submitting} failure={failure} onSubmit={submit}>
        {detail}
      </AnswerForm>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Decision" }} />
      {content}
    </View>
  );
}

export default function DecisionScreen() {
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (typeof id !== "string" || id === "") {
    return <NotFound />;
  }
  // Keyed by id: another decision starts with no draft and no returned
  // outcome.
  return (
    <QueryErrorBoundary
      key={id}
      fallback={(error, retry) =>
        isNotFound(error) ? (
          <NotFound />
        ) : (
          <View style={styles.centered}>
            <Stack.Screen options={{ title: "Decision" }} />
            <EmptyState
              icon="cloud-offline-outline"
              title="Could not load this decision."
              body="Check your connection and try again."
            >
              <Button label="Try again" onPress={retry} />
            </EmptyState>
          </View>
        )
      }
    >
      <DecisionView key={id} id={id} />
    </QueryErrorBoundary>
  );
}
