import { type Decision, errorCodeSchema } from "@agentdesk/contract";
import { useMutation, usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActionSheetIOS, Alert, Platform, Pressable, View } from "react-native";
import { decisions } from "../../../convex/decisions/refs";
import { Button } from "./button";
import { formatAnswer } from "./decision-detail";
import {
  type AppDecision,
  CHAT_MESSAGE_LABEL,
  cancellationReason,
  chatMessageOf,
} from "./decision-outcome";
import { haptic } from "./haptics";
import { Loading } from "./loading";
import { errorData } from "./query-error-boundary";
import { makeStyles, spacing, type Theme, useTheme } from "./theme";
import { EmptyState } from "./ui/empty-state";
import { GroupedSection } from "./ui/grouped";
import { Icon, type IconName } from "./ui/icon";
import { SwipeRow } from "./ui/swipe-row";
import { AppText } from "./ui/text";

// component-mobile-app §Screens, history: settled decisions from
// `decisions/app:searchHistory` and deletion through `decisions/app:remove`
// (req-mobile-app REQ-6), confirmed in the system's action sheet. The query is a native Convex paginated query, so
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

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// The day heading a settled row is grouped under, in the device's time zone:
// Today, Yesterday, the weekday within the past week, and the date before
// that (with the year once it is not the current one).
export function settledDay(settledAt: string, now: number): string {
  const settled = Date.parse(settledAt);
  // Rounded, so a day that a daylight-saving change shortens still counts once.
  const days = Math.round((startOfDay(now) - startOfDay(settled)) / DAY_MS);
  if (days === 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  const date = new Date(settled);
  if (days > 1 && days < 7) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

// The settlement time of day from the query's `settled_at`, in the device's
// locale and time zone. The day heading above the row carries the date.
export function formatSettledTime(settledAt: string): string {
  return new Date(settledAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// What the row says about the outcome: the answer, an answer given in chat,
// the applied default, why a decision was cancelled when the backend
// recorded a reason, or that no answer was recorded.
export function answerSummary(decision: AppDecision): string {
  if (decision.answer === null) {
    const reason = cancellationReason(decision);
    if (reason !== null) {
      return `${reason}.`;
    }
    return decision.state === "expired" ? "Expired without an answer" : "No answer was recorded.";
  }
  const answer = formatAnswer(decision.answer, decision.options);
  if (decision.applied_by_default) {
    return `Default applied: ${answer}`;
  }
  return decision.answered_via === "chat" ? `Answered in chat: ${answer}` : `Answer: ${answer}`;
}

// The short outcome on the right of a row: the answer, the applied default,
// or the state when no answer was recorded.
export function outcomeValue(decision: Decision): string {
  if (decision.answer === null) {
    return STATE_LABELS[decision.state];
  }
  const answer = formatAnswer(decision.answer, decision.options);
  return decision.applied_by_default ? `Default: ${answer}` : answer;
}

// The outcome icon (design "History"): green check for an answer, accent
// check for an applied default, grey clock for expired without an answer,
// tertiary x for cancelled.
function outcomeIcon(decision: Decision, theme: Theme): { name: IconName; color: string } {
  if (decision.answer !== null) {
    return decision.applied_by_default
      ? { name: "checkmark-circle", color: theme.accent }
      : { name: "checkmark-circle", color: theme.green };
  }
  return decision.state === "cancelled"
    ? { name: "close-circle", color: theme.textTertiary }
    : { name: "time", color: theme.grey };
}

export const CONFLICT_MESSAGE = "This decision is pending and cannot be deleted.";
export const NOT_FOUND_MESSAGE = "This decision was removed elsewhere.";

export type Deletion = {
  pendingId: string | null;
  failure: { id: string; message: string } | null;
  notice: string | null;
  request: (decision: Decision) => void;
};

export const DELETE_ACTION = "Delete Decision";

// Apple HIG Action sheets: a destructive choice that follows an intentional
// action (a swipe or a long press on the row) is confirmed in an action sheet
// whose destructive button names the action, with Cancel. Android has no
// action sheet, so it uses the system alert with the same buttons.
function confirmDeletion(title: string, onDelete: () => void) {
  const heading = `Delete "${title}"?`;
  const message = "It leaves every screen. This cannot be undone.";
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: heading,
        message,
        options: [DELETE_ACTION, "Cancel"],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      (index) => {
        if (index === 0) {
          onDelete();
        }
      },
    );
    return;
  }
  Alert.alert(heading, message, [
    { text: "Cancel", style: "cancel" },
    { text: DELETE_ACTION, style: "destructive", onPress: onDelete },
  ]);
}

// The screen's deletion state. It lives above the list's error boundary, so
// a new search input or a retried query cannot start a second deletion while
// one runs.
export function useHistoryDeletion(): Deletion {
  const remove: Remove = useMutation(decisions.app.remove);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set synchronously, so a second confirmation before the re-render sends
  // nothing.
  const pending = useRef(false);
  // A call that settles after the screen unmounts changes nothing.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (decision: Decision) => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    const id = decision.id;
    setPendingId(id);
    setFailure(null);
    setNotice(null);
    // Apple HIG Playing haptics: the outcome of the deletion is felt. A
    // failure is also spoken to VoiceOver when its message appears.
    try {
      await remove({ decisionId: id });
      if (mounted.current) {
        haptic.success();
      }
    } catch (error) {
      if (mounted.current) {
        const code = errorData(error)?.code;
        let message: string;
        if (code === errorCodeSchema.enum.conflict) {
          message = CONFLICT_MESSAGE;
          setNotice(message);
        } else if (code === errorCodeSchema.enum.not_found) {
          message = NOT_FOUND_MESSAGE;
          setNotice(message);
        } else {
          message = `Could not delete "${decision.title}". Try again.`;
          setFailure({ id, message });
        }
        haptic.error();
        AccessibilityInfo.announceForAccessibility(message);
      }
    } finally {
      pending.current = false;
      if (mounted.current) {
        setPendingId(null);
      }
    }
  };

  return {
    pendingId,
    failure,
    notice,
    request: (decision) => {
      if (pending.current) {
        return;
      }
      confirmDeletion(decision.title, () => void run(decision));
    },
  };
}

export const LOAD_FAILURE = "Could not load your history.";

// The list's load failure. VoiceOver speaks it when it appears, since the
// rows it replaces were the focus.
export function HistoryLoadFailure({ children }: { children: ReactNode }) {
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(LOAD_FAILURE);
  }, []);
  return (
    <EmptyState icon="cloud-offline-outline" title={LOAD_FAILURE}>
      {children}
    </EmptyState>
  );
}

const useStyles = makeStyles((theme) => ({
  list: { paddingBottom: 8 },
  row: {
    alignItems: "center",
    backgroundColor: theme.card,
    flexDirection: "row",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressed: { backgroundColor: theme.fill },
  grow: { flex: 1, gap: 2 },
  value: { flexShrink: 1, maxWidth: "40%" },
  below: { paddingBottom: 12, paddingHorizontal: 16 },
  more: { marginHorizontal: spacing.screen, marginTop: 16 },
}));

// One settled decision: the outcome icon, the title, "topic · time", and the
// outcome on the right, which is text as well as the icon's color. A
// decision answered in chat shows "Answered in chat: <answer>" under the
// title instead of the outcome on the right, and the user's chat message
// below it, cut to two lines (component-mobile-app §Screens, Rows;
// req-decision-requests AC-8.3); the decision screen shows the whole
// message. A decision cancelled because its agent's machine disconnected
// says so under the title (req-install-keys AC-4.2). Tapping
// opens the decision; a long press asks to delete it, the alternative to the
// swipe (Apple HIG Gestures), and the hint tells VoiceOver so.
function HistoryRowContent({
  item,
  onLongPress,
}: {
  item: HistoryItem;
  onLongPress: (() => void) | undefined;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const { decision } = item;
  const icon = outcomeIcon(decision, theme);
  const time = formatSettledTime(item.settled_at);
  const chatMessage = decision.answer === null ? null : chatMessageOf(decision);
  const reason = cancellationReason(decision);
  const summary = answerSummary(decision);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Decision: ${decision.title}`}
      accessibilityValue={{
        text:
          chatMessage === null
            ? `${STATE_LABELS[decision.state]}. ${summary} ${decision.topic}, settled ${time}`
            : `${STATE_LABELS[decision.state]}. ${summary}. ${CHAT_MESSAGE_LABEL}: ${chatMessage}. ${decision.topic}, settled ${time}`,
      }}
      accessibilityHint={onLongPress === undefined ? undefined : "Touch and hold to delete."}
      // The row itself carries Delete as a VoiceOver action: iOS only offers
      // actions on the focused element, which is this row, not the swipe
      // container around it.
      accessibilityActions={
        onLongPress === undefined ? undefined : [{ name: "delete", label: "Delete" }]
      }
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "delete") {
          onLongPress?.();
        }
      }}
      onLongPress={onLongPress}
      onPress={() => router.push({ pathname: "/decision/[id]", params: { id: decision.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Icon name={icon.name} size={22} color={icon.color} />
      <View style={styles.grow}>
        <AppText numberOfLines={2}>{decision.title}</AppText>
        <AppText variant="footnote" tone="secondary" numberOfLines={1}>
          {`${decision.topic} · ${time}`}
        </AppText>
        {reason === null ? null : (
          <AppText variant="footnote" tone="secondary" numberOfLines={2}>
            {reason}
          </AppText>
        )}
        {chatMessage === null ? null : (
          <>
            <AppText variant="subhead" numberOfLines={2}>
              {summary}
            </AppText>
            <AppText variant="footnote" tone="secondary" numberOfLines={2}>
              {chatMessage}
            </AppText>
          </>
        )}
      </View>
      {chatMessage === null ? (
        <AppText tone="secondary" numberOfLines={1} style={styles.value}>
          {outcomeValue(decision)}
        </AppText>
      ) : null}
    </Pressable>
  );
}

// A row and any deletion failure. Swiping left reveals Delete (AC-6.2), and a
// long press offers it too; either asks for confirmation. While a deletion
// runs the rows offer no Delete, so a second one cannot start.
function HistoryRow({
  item,
  busy,
  error,
  deletion,
}: {
  item: HistoryItem;
  busy: boolean;
  error: string | null;
  deletion: Deletion;
}) {
  const styles = useStyles();
  const { decision } = item;
  const request = () => deletion.request(decision);
  return (
    <View>
      {busy ? (
        <HistoryRowContent item={item} onLongPress={undefined} />
      ) : (
        <SwipeRow actionLabel="Delete" onAction={request}>
          <HistoryRowContent item={item} onLongPress={request} />
        </SwipeRow>
      )}
      {error === null ? null : (
        <View style={styles.below}>
          <AppText variant="footnote" tone="red">
            {error}
          </AppText>
        </View>
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

// Consecutive rows settled on the same day share a section, so the query's
// order is kept as it is.
function groupByDay(rows: HistoryItem[], now: number) {
  const groups: { day: string; rows: HistoryItem[] }[] = [];
  for (const item of rows) {
    const day = settledDay(item.settled_at, now);
    const last = groups.at(-1);
    if (last !== undefined && last.day === day) {
      last.rows.push(item);
    } else {
      groups.push({ day, rows: [item] });
    }
  }
  return groups;
}

// The loaded history for one set of committed inputs. The screen keys its
// error boundary, and so this list, by those inputs, so a change starts again
// from the first page. A failed page throws to that boundary, so a failure
// never reads as an empty or exhausted list. `onTopics` reports the topics of
// the loaded rows, which the screen offers as topic chips.
export function HistoryList({
  args,
  filtered,
  deletion,
  onTopics,
}: {
  args: HistoryArgs;
  filtered: boolean;
  deletion: Deletion;
  onTopics: (topics: string[]) => void;
}) {
  const styles = useStyles();
  const { results, status, loadMore } = usePaginatedQuery(decisions.app.searchHistory, args, {
    initialNumItems: HISTORY_PAGE_SIZE,
  });
  const rows = uniqueRows(results);
  const topicsKey = [...new Set(rows.map((item) => item.decision.topic))].join("\n");
  useEffect(() => {
    if (topicsKey !== "") {
      onTopics(topicsKey.split("\n"));
    }
  }, [topicsKey, onTopics]);

  if (status === "LoadingFirstPage") {
    return <Loading label="Loading history" />;
  }
  const busy = deletion.pendingId !== null;

  return (
    <View style={styles.list}>
      {rows.length === 0 ? (
        status === "Exhausted" ? (
          filtered ? (
            <EmptyState
              icon="search"
              title="No matches."
              body="Try other words, another state, or another topic."
            />
          ) : (
            <EmptyState
              icon="time-outline"
              title="No settled decisions."
              body="Answered, expired, and cancelled decisions appear here."
            />
          )
        ) : null
      ) : (
        groupByDay(rows, Date.now()).map((group) => (
          // Two runs can share a day heading when the query's order crosses
          // days, so a section is keyed by its first row.
          <GroupedSection key={group.rows[0]?.decision.id} title={group.day}>
            {group.rows.map((item) => (
              <HistoryRow
                key={item.decision.id}
                item={item}
                busy={busy}
                error={deletion.failure?.id === item.decision.id ? deletion.failure.message : null}
                deletion={deletion}
              />
            ))}
          </GroupedSection>
        ))
      )}
      {status === "Exhausted" ? null : (
        <View style={styles.more}>
          <Button
            label={status === "LoadingMore" ? "Loading more" : "Load more"}
            variant="secondary"
            onPress={() => loadMore(HISTORY_PAGE_SIZE)}
            disabled={status === "LoadingMore"}
          />
        </View>
      )}
    </View>
  );
}
