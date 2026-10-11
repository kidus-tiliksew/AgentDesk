import { type AnswerSubmission, type Decision, errorCodeSchema } from "@agentdesk/contract";
import { useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { type ReactNode, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { decisions } from "../../../../../convex/decisions/refs";
import { Button } from "../../../src/button";
import { AnswerForm } from "../../../src/decision-answer-form";
import { DecisionDetail, SettledOutcome } from "../../../src/decision-detail";
import { answerFailure } from "../../../src/decision-errors";
import { Loading } from "../../../src/loading";
import { errorData, QueryErrorBoundary } from "../../../src/query-error-boundary";
import { styles } from "../../../src/styles";
import { useScreenClock } from "../../../src/use-screen-clock";

// component-mobile-app §Screens: one decision, its details, and the answer
// controls for its input type (req-mobile-app REQ-3). The answer goes through
// `decisions/app:answer`, which records `answeredVia: "app"`.

function NotFound() {
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: "Decision" }} />
      <Text style={styles.title}>Decision not found</Text>
      <Text style={styles.body}>This decision does not exist or is not yours.</Text>
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

function DecisionView({ id }: { id: string }) {
  const queried = useQuery(decisions.app.get, { decisionId: id });
  const answer = useMutation(decisions.app.answer);
  const now = useScreenClock();
  // A settled decision the mutation returned, from success or from a
  // `conflict`. It stands in for the query until the subscription reports
  // the settlement, so the form never comes back for a settled decision.
  const [returned, setReturned] = useState<Decision | null>(null);
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
  // other failure keeps the draft for a deliberate retry.
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
        (settled) => setReturned(settled),
        (error: unknown) => {
          const result = answerFailure(error);
          if (result.kind === "conflict") {
            setReturned(result.decision);
            setConflicted(true);
          } else if (result.kind === "malformed_conflict") {
            setUnreadable(true);
          } else {
            setFailure(result.message);
          }
        },
      )
      .finally(() => {
        inFlight.current = false;
        setSubmitting(false);
      });
  };

  let footer: ReactNode;
  if (decision.state !== "pending") {
    footer = (
      <>
        {conflicted ? (
          <Text style={styles.error}>
            This decision was settled before your answer arrived. Your answer was not recorded.
          </Text>
        ) : null}
        <SettledOutcome decision={decision} />
      </>
    );
  } else if (unreadable) {
    footer = (
      <Text style={styles.error}>
        This decision was settled elsewhere. Its recorded outcome appears here once it loads.
      </Text>
    );
  } else {
    footer = (
      <AnswerForm decision={decision} submitting={submitting} failure={failure} onSubmit={submit} />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: "Decision" }} />
      <DecisionDetail decision={decision} now={now} />
      {footer}
    </ScrollView>
  );
}

export default function DecisionScreen() {
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
            <Text style={styles.error}>Could not load this decision.</Text>
            <Button label="Try again" onPress={retry} />
          </View>
        )
      }
    >
      <DecisionView key={id} id={id} />
    </QueryErrorBoundary>
  );
}
