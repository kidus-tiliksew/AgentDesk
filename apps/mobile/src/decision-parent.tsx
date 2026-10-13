import { errorCodeSchema } from "@agentdesk/contract";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { Fragment, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { decisions } from "../../../convex/decisions/refs";
import { outcomeColor, outcomeOf } from "./decision-outcome";
import { errorData, QueryErrorBoundary } from "./query-error-boundary";
import { makeStyles, radius, spacing, useTheme } from "./theme";
import { Icon, type IconName } from "./ui/icon";
import { AppText } from "./ui/text";

// The decision's thread: the parent it follows up and its own follow-ups,
// each a row that opens that decision (req-mobile-app AC-3.1; prototype
// "Decision: settled", where follow-ups read as a thread). Each related
// decision is read in its own error boundary, so a lookup failure never
// hides the decision or its answer controls.

const useStyles = makeStyles((theme) => ({
  card: {
    backgroundColor: theme.card,
    borderRadius: radius.control,
    marginHorizontal: spacing.screen,
    overflow: "hidden",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pressed: { backgroundColor: theme.fill },
  grow: { flex: 1 },
  separator: { backgroundColor: theme.separator, height: 0.5, marginLeft: 38 },
  label: { paddingBottom: 7, paddingHorizontal: 32, paddingTop: 18, textTransform: "uppercase" },
}));

function useOpen() {
  const router = useRouter();
  return (id: string) => router.push({ pathname: "/decision/[id]", params: { id } });
}

// One row of a thread card. With `onPress` it is a link to that decision.
function ThreadRow({
  icon,
  iconColor,
  label,
  value,
  onPress,
  children,
}: {
  icon: IconName;
  iconColor?: string;
  label?: string;
  value?: string;
  onPress?: () => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const content = (
    <>
      <Icon name={icon} size={17} color={iconColor ?? theme.textSecondary} />
      <View style={styles.grow}>{children}</View>
      {value === undefined ? null : (
        <AppText variant="subhead" tone="secondary">
          {value}
        </AppText>
      )}
      {onPress === undefined ? null : (
        <Icon name="chevron-forward" size={16} color={theme.textTertiary} />
      )}
    </>
  );
  if (onPress === undefined) {
    return <View style={styles.row}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

function Retry({
  message,
  label,
  onPress,
}: {
  message: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <ThreadRow icon="alert-circle-outline">
      <AppText variant="subhead" tone="red">
        {message}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        // Apple HIG Buttons: a text link keeps a 44 pt hit region.
        hitSlop={{ top: 16, bottom: 16, left: 8, right: 8 }}
        onPress={onPress}
      >
        <AppText variant="subhead" tone="accent" weight="600">
          Retry
        </AppText>
      </Pressable>
    </ThreadRow>
  );
}

// `decisions/app:get` answers `not_found` for a removed, missing, or foreign
// decision, and `invalid` naming `decisionId` for a malformed id.
function isGone(error: unknown) {
  const data = errorData(error);
  return (
    data !== null &&
    (data.code === errorCodeSchema.enum.not_found ||
      (data.code === errorCodeSchema.enum.invalid && data.field === "decisionId"))
  );
}

function ParentLink({ id }: { id: string }) {
  const open = useOpen();
  const parent = useQuery(decisions.app.get, { decisionId: id });
  if (parent === undefined) {
    return (
      <ThreadRow icon="return-down-forward">
        <AppText variant="subhead" tone="secondary">
          Loading parent
        </AppText>
      </ThreadRow>
    );
  }
  return (
    <ThreadRow
      icon="return-down-forward"
      label={`Follow-up to ${parent.title}`}
      onPress={() => open(id)}
    >
      <AppText variant="subhead" tone="secondary" numberOfLines={2}>
        {"Follow-up to "}
        <AppText variant="subhead" weight="600">
          {parent.title}
        </AppText>
      </AppText>
    </ThreadRow>
  );
}

// Removing a decision keeps its id on each follow-up's `parent_id`
// (component-decisions §Removal), so a removed parent reads as unavailable.
export function DecisionParent({ parentId }: { parentId: string }) {
  const styles = useStyles();
  return (
    <View style={styles.card}>
      <QueryErrorBoundary
        key={parentId}
        fallback={(error, retry) =>
          isGone(error) ? (
            <ThreadRow icon="return-down-forward">
              <AppText variant="subhead" tone="secondary">
                Parent decision unavailable
              </AppText>
            </ThreadRow>
          ) : (
            <Retry
              message="Could not load the parent decision."
              label="Retry parent"
              onPress={retry}
            />
          )
        }
      >
        <ParentLink id={parentId} />
      </QueryErrorBoundary>
    </View>
  );
}

// A follow-up as a link by position alone, while its decision loads or when
// it cannot be read; the opened screen shows a removed one as not found.
function NumberedFollowUp({ id, index }: { id: string; index: number }) {
  const open = useOpen();
  const label = `Follow-up decision ${index + 1}`;
  return (
    <ThreadRow icon="chatbubble-ellipses-outline" label={label} onPress={() => open(id)}>
      <AppText variant="subhead">{label}</AppText>
    </ThreadRow>
  );
}

function FollowUpLink({ id, index }: { id: string; index: number }) {
  const open = useOpen();
  const theme = useTheme();
  const followUp = useQuery(decisions.app.get, { decisionId: id });
  if (followUp === undefined) {
    return <NumberedFollowUp id={id} index={index} />;
  }
  const outcome = outcomeOf(followUp);
  return (
    <ThreadRow
      icon={outcome.icon}
      iconColor={outcomeColor(theme, outcome.tone)}
      label={`Follow-up: ${followUp.title}, ${outcome.title}`}
      value={outcome.title}
      onPress={() => open(id)}
    >
      <AppText variant="subhead" numberOfLines={2}>
        {followUp.title}
      </AppText>
    </ThreadRow>
  );
}

export function DecisionFollowUps({ ids }: { ids: readonly string[] }) {
  const styles = useStyles();
  return (
    <View>
      <AppText accessibilityRole="header" variant="footnote" tone="secondary" style={styles.label}>
        Follow-ups
      </AppText>
      <View style={styles.card}>
        {ids.map((id, index) => (
          <Fragment key={id}>
            {index === 0 ? null : <View style={styles.separator} />}
            <QueryErrorBoundary
              key={id}
              fallback={() => <NumberedFollowUp id={id} index={index} />}
            >
              <FollowUpLink id={id} index={index} />
            </QueryErrorBoundary>
          </Fragment>
        ))}
      </View>
    </View>
  );
}
