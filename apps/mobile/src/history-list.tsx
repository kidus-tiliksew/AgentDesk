import { type Decision, errorCodeSchema } from "@agentdesk/contract";
import { useMutation, usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { decisions } from "../../../convex/decisions/refs";
import { Button } from "./button";
import { formatAnswer } from "./decision-detail";
import { Loading } from "./loading";
import { errorData } from "./query-error-boundary";
import { styles } from "./styles";

// component-mobile-app §Screens, history: settled decisions from
// `decisions/app:searchHistory` and deletion through `decisions/app:remove`
// (req-mobile-app REQ-6). The query is a native Convex paginated query, so
// `usePaginatedQuery` follows its cursors and keeps every loaded page
// subscribed. A removed decision leaves the list when the query reports it;
// the screen never removes a row itself.

export type HistoryItem = FunctionReturnType<typeof decisions.app.searchHistory>["page"][number];
export type HistoryArgs = { query?: string; state?: string; topic?: string };
type Remove = (args: { decisionId: string }) => Promise<null>;

// The first page and each Load more request this many rows. The server
// clamps a request to 1..50.
export const HISTORY_PAGE_SIZE = 20;

const STATE_LABELS: Record<Decision["state"], string> = {
  pending: "Pending",
  answered: "Answered",
  expired: "Expired",
  cancelled: "Cancelled",
};

// The settlement instant from the query's `settled_at`, in the device's
// locale and time zone.
export function formatSettledTime(settledAt: string): string {
  return new Date(settledAt).toLocaleString();
}

// What the row says about the outcome: the answer, the applied default, or
// that no answer was recorded.
export function answerSummary(decision: Decision): string {
  if (decision.answer === null) {
    return decision.state === "expired" ? "Expired without an answer" : "No answer was recorded.";
  }
  const answer = formatAnswer(decision.answer, decision.options);
  return decision.applied_by_default ? `Default applied: ${answer}` : `Answer: ${answer}`;
}

export const CONFLICT_MESSAGE = "This decision is pending and cannot be deleted.";
export const NOT_FOUND_MESSAGE = "This decision was removed elsewhere.";

export type Deletion = {
  confirmingId: string | null;
  pendingId: string | null;
  failure: { id: string; message: string } | null;
  notice: string | null;
  open: (decision: Decision) => void;
  cancel: () => void;
  confirm: (decision: Decision, remove: Remove) => void;
};

// The screen's deletion state. It lives above the list's error boundary, so
// a new search input or a retried query cannot start a second deletion while
// one runs.
export function useHistoryDeletion(): Deletion {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set synchronously, so a second press before the re-render sends nothing.
  const pending = useRef(false);
  // A call that settles after the screen unmounts changes nothing.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const confirm = async (decision: Decision, remove: Remove) => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    const id = decision.id;
    setPendingId(id);
    setFailure(null);
    setNotice(null);
    try {
      await remove({ decisionId: id });
      if (mounted.current) {
        setConfirmingId(null);
      }
    } catch (error) {
      if (mounted.current) {
        const code = errorData(error)?.code;
        if (code === errorCodeSchema.enum.conflict) {
          setConfirmingId(null);
          setNotice(CONFLICT_MESSAGE);
        } else if (code === errorCodeSchema.enum.not_found) {
          setConfirmingId(null);
          setNotice(NOT_FOUND_MESSAGE);
        } else {
          setFailure({ id, message: `Could not delete "${decision.title}". Try again.` });
        }
      }
    } finally {
      pending.current = false;
      if (mounted.current) {
        setPendingId(null);
      }
    }
  };

  return {
    confirmingId,
    pendingId,
    failure,
    notice,
    open: (decision) => {
      if (pending.current) {
        return;
      }
      setFailure(null);
      setNotice(null);
      setConfirmingId(decision.id);
    },
    cancel: () => {
      if (pending.current) {
        return;
      }
      setFailure(null);
      setConfirmingId(null);
    },
    confirm: (decision, remove) => void confirm(decision, remove),
  };
}

// The open confirmation in a row. It owns the remove hook, so the list binds
// the mutation only while a person is confirming a deletion.
function DeleteConfirmation({
  decision,
  busy,
  onConfirm,
  onCancel,
}: {
  decision: Decision;
  busy: boolean;
  onConfirm: (remove: Remove) => void;
  onCancel: () => void;
}) {
  const remove = useMutation(decisions.app.remove);
  return (
    <View style={styles.outcome}>
      <Text style={styles.line}>
        {`Delete "${decision.title}" from every screen? This cannot be undone.`}
      </Text>
      <Button label="Delete decision" onPress={() => onConfirm(remove)} disabled={busy} />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onCancel}
      >
        <Text style={styles.link}>Cancel</Text>
      </Pressable>
    </View>
  );
}

function HistoryRow({
  item,
  confirming,
  busy,
  error,
  deletion,
}: {
  item: HistoryItem;
  confirming: boolean;
  busy: boolean;
  error: string | null;
  deletion: Deletion;
}) {
  const router = useRouter();
  const { decision } = item;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Decision: ${decision.title}`}
        onPress={() => router.push({ pathname: "/decision/[id]", params: { id: decision.id } })}
        style={styles.list}
      >
        <Text style={styles.rowTitle}>{decision.title}</Text>
        <View style={styles.rowMeta}>
          <Text style={styles.meta}>{decision.topic}</Text>
          <Text style={styles.meta}>{STATE_LABELS[decision.state]}</Text>
          <Text style={styles.meta}>{`Settled ${formatSettledTime(item.settled_at)}`}</Text>
        </View>
        <Text style={styles.line}>{answerSummary(decision)}</Text>
      </Pressable>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
      {confirming ? (
        <DeleteConfirmation
          decision={decision}
          busy={busy}
          onConfirm={(remove) => deletion.confirm(decision, remove)}
          onCancel={deletion.cancel}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${decision.title}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => deletion.open(decision)}
        >
          <Text style={styles.link}>Delete</Text>
        </Pressable>
      )}
    </View>
  );
}

// Loaded rows in page order. A row that a live page change shows twice
// appears once, at its first position.
function uniqueRows(results: HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>();
  return results.filter((item) => {
    if (seen.has(item.decision.id)) {
      return false;
    }
    seen.add(item.decision.id);
    return true;
  });
}

// The loaded history for one set of committed inputs. The screen keys its
// error boundary, and so this list, by those inputs, so a change starts again
// from the first page. A failed page throws to that boundary, so a failure
// never reads as an empty or exhausted list.
export function HistoryList({
  args,
  filtered,
  deletion,
}: {
  args: HistoryArgs;
  filtered: boolean;
  deletion: Deletion;
}) {
  const { results, status, loadMore } = usePaginatedQuery(decisions.app.searchHistory, args, {
    initialNumItems: HISTORY_PAGE_SIZE,
  });

  if (status === "LoadingFirstPage") {
    return <Loading label="Loading history" />;
  }
  const rows = uniqueRows(results);
  const busy = deletion.pendingId !== null;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      {rows.length === 0 ? (
        status === "Exhausted" ? (
          <Text style={styles.empty}>{filtered ? "No matches." : "No settled decisions."}</Text>
        ) : null
      ) : (
        <View style={styles.list}>
          {rows.map((item) => (
            <HistoryRow
              key={item.decision.id}
              item={item}
              confirming={deletion.confirmingId === item.decision.id}
              busy={busy}
              error={deletion.failure?.id === item.decision.id ? deletion.failure.message : null}
              deletion={deletion}
            />
          ))}
        </View>
      )}
      {status === "Exhausted" ? null : (
        <Button
          label={status === "LoadingMore" ? "Loading more" : "Load more"}
          onPress={() => loadMore(HISTORY_PAGE_SIZE)}
          disabled={status === "LoadingMore"}
        />
      )}
    </ScrollView>
  );
}
