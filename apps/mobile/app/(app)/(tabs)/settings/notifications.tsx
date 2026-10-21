import { errorCodeSchema } from "@agentdesk/contract";
import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { Stack, useNavigation } from "expo-router";
import { HeaderHeightContext, usePreventRemove } from "expo-router/react-navigation";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Switch,
  TextInput,
  View,
} from "react-native";
import { notifications } from "../../../../../../convex/notifications/refs";
import type { NotificationSettings } from "../../../../../../convex/notifications/settings";
import { Button } from "../../../../src/button";
import { confirmDiscard } from "../../../../src/confirm";
import { haptic } from "../../../../src/haptics";
import { Loading } from "../../../../src/loading";
import {
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  type Draft,
  draftOf,
  type FieldErrors,
  isSettingsField,
  overnightLabel,
  parseTime,
  refusalMessage,
  type SettingsField,
  sameDraft,
  sameSettings,
  type UpdateArgs,
  validateDraft,
  zoneName,
} from "../../../../src/notification-settings";
import { PushStatus } from "../../../../src/notification-settings-status";
import { TimeRow } from "../../../../src/notification-settings-time";
import { ZoneSheet } from "../../../../src/notification-settings-zone";
import { errorData, QueryErrorBoundary } from "../../../../src/query-error-boundary";
import { HeaderButton } from "../../../../src/rules/header-button";
import { makeStyles, radius, useTheme } from "../../../../src/theme";
import { Dock } from "../../../../src/ui/dock";
import { EmptyState } from "../../../../src/ui/empty-state";
import { GroupedRow, GroupedSection } from "../../../../src/ui/grouped";
import { Icon } from "../../../../src/ui/icon";
import { StackScreen } from "../../../../src/ui/screen";
import { AppText } from "../../../../src/ui/text";

// component-mobile-app §Screens, notification settings: quiet hours, urgent
// override, digest time, time zone, and stale threshold (req-mobile-app
// REQ-5; req-notification-rules REQ-5, REQ-6; req-agent-status AC-3.1). The
// screen reads `notifications/settings:getSettings` and saves the whole form
// with one `updateSettings` call. The backend checks every field again.
//
// The layout is an iOS grouped list (prototype frame "Notification
// settings"): this device's push status, quiet hours with switches and native
// time pickers, the digest time, the stale threshold, and a time zone row
// that opens a searchable sheet. Save stays pinned below the list, so an edit
// anywhere is one tap from saving. The screen moves Save above the keyboard,
// and leaving with unsaved edits asks to discard them first.

type Update = (args: UpdateArgs) => Promise<NotificationSettings>;

const SAVE_FAILED = "Could not save your settings. Check your connection and try again.";
const REFUSED = "AgentDesk refused these settings. Check the fields and save again.";
const SAVED = "Settings saved.";

// The stale threshold's number pad has no return key; this toolbar above it
// carries Done (Apple HIG Virtual keyboards).
const THRESHOLD_TOOLBAR = "stale-threshold-toolbar";

const QUIET_NOTE =
  "During quiet hours, notifications that would push go to the daily digest instead.";
const URGENT_ON = "Urgent decisions still push during quiet hours.";
const URGENT_OFF = "Urgent decisions go to the digest during quiet hours, like everything else.";
const FALLBACK_NOTE = "No time zone has been recorded from this device yet, so AgentDesk uses UTC.";

const useStyles = makeStyles((theme) => ({
  root: { backgroundColor: theme.background, flex: 1 },
  notes: { gap: 4, paddingHorizontal: 32, paddingTop: 7 },
  threshold: { alignItems: "center", flexDirection: "row", gap: 6 },
  thresholdInput: {
    backgroundColor: theme.fill,
    borderRadius: radius.small - 2,
    color: theme.text,
    fontSize: 17,
    minWidth: 56,
    paddingHorizontal: 10,
    paddingVertical: 6,
    textAlign: "right",
  },
  status: { alignItems: "center", flexDirection: "row", gap: 6, justifyContent: "center" },
  toolbar: {
    alignItems: "flex-end",
    backgroundColor: theme.tabBar,
    borderTopColor: theme.separator,
    borderTopWidth: 0.5,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
}));

// A section's footnotes under its rows, and its field errors in red.
function Notes({
  lines,
  errors = [],
}: {
  lines: (string | null)[];
  errors?: (string | undefined)[];
}) {
  const styles = useStyles();
  return (
    <View style={styles.notes}>
      {errors.map((message) =>
        message === undefined ? null : (
          <AppText key={message} variant="footnote" tone="red">
            {message}
          </AppText>
        ),
      )}
      {lines.map((line) =>
        line === null ? null : (
          <AppText key={line} variant="footnote" tone="secondary">
            {line}
          </AppText>
        ),
      )}
    </View>
  );
}

function Toggle({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <Switch
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onValueChange={onChange}
      trackColor={{ true: theme.green }}
      value={value}
    />
  );
}

// The Save action. It owns the `updateSettings` hook, so the screen binds the
// mutation only once the settings have loaded and the form is shown, and
// calls it only on a press.
function SaveControl({
  label,
  disabled,
  onSave,
}: {
  label: string;
  disabled: boolean;
  onSave: (update: Update) => void;
}) {
  const update = useMutation(notifications.settings.updateSettings);
  return <Button label={label} onPress={() => onSave(update)} disabled={disabled} grow />;
}

type Failure = { fields: FieldErrors; form: string | null };

const NO_FAILURE: Failure = { fields: {}, form: null };

function hasFailure(failure: Failure) {
  return failure.form !== null || Object.keys(failure.fields).length > 0;
}

function SettingsForm({ settings }: { settings: NotificationSettings }) {
  const { sessionId } = useAuth();
  // The settings the draft started from or that the last save returned.
  const [base, setBase] = useState(settings);
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure>(NO_FAILURE);
  const [saved, setSaved] = useState(false);
  // Whether the time zone sheet is open.
  const [picking, setPicking] = useState(false);
  const styles = useStyles();
  const theme = useTheme();
  const navigation = useNavigation();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  // The arguments of a save that failed for a reason other than a refusal.
  // Any edit clears them, so an unchanged form retries the same call and an
  // edited one is checked again.
  const [failedArgs, setFailedArgs] = useState<UpdateArgs | null>(null);
  // Set synchronously, so a second press before the re-render sends nothing.
  const busy = useRef(false);
  const mounted = useRef(true);
  const session = useRef(sessionId);
  useLayoutEffect(() => {
    session.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A reactive change replaces the draft only while the person has no edit,
  // no save running, and no failed save on screen.
  if (
    !sameSettings(settings, base) &&
    !pending &&
    !hasFailure(failure) &&
    sameDraft(draft, draftOf(base))
  ) {
    setBase(settings);
    setDraft(draftOf(settings));
  }

  // Apple HIG Modality: the back button, the back swipe, and the Settings
  // tab's pop to top ask before throwing away an edit. A running save or an
  // unchanged form leaves without asking.
  usePreventRemove(!pending && !sameDraft(draft, draftOf(base)), ({ data }) =>
    confirmDiscard(() => navigation.dispatch(data.action)),
  );

  // Apple HIG Accessibility: a refusal appears away from the Save button,
  // so VoiceOver reads it out; a haptic marks the failure.
  const announceFailure = (messages: (string | null | undefined)[]) => {
    haptic.error();
    const spoken = messages.filter((message) => typeof message === "string").join(" ");
    if (spoken !== "") {
      AccessibilityInfo.announceForAccessibility(spoken);
    }
  };

  const edit = (fields: SettingsField[], patch: Partial<Draft>) => {
    if (busy.current) {
      return;
    }
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
    setFailedArgs(null);
    setFailure((current) => {
      const remaining = { ...current.fields };
      for (const field of fields) {
        delete remaining[field];
      }
      return { fields: remaining, form: null };
    });
  };

  const save = async (update: Update) => {
    if (busy.current) {
      return;
    }
    let args = failedArgs;
    if (args === null) {
      const checked = validateDraft(draft);
      if (!checked.ok) {
        setSaved(false);
        setFailure({ fields: checked.errors, form: null });
        announceFailure(Object.values(checked.errors));
        return;
      }
      args = checked.args;
    }
    busy.current = true;
    const startedIn = session.current;
    setPending(true);
    setSaved(false);
    setFailure(NO_FAILURE);
    const live = () => mounted.current && session.current === startedIn;
    try {
      const result = await update(args);
      if (live()) {
        setBase(result);
        setDraft(draftOf(result));
        setFailedArgs(null);
        setSaved(true);
        haptic.success();
        AccessibilityInfo.announceForAccessibility(SAVED);
      }
    } catch (error) {
      if (live()) {
        const data = errorData(error);
        if (data?.code === errorCodeSchema.enum.invalid) {
          const refused: Failure = isSettingsField(data.field)
            ? { fields: { [data.field]: refusalMessage(data.field) }, form: null }
            : { fields: {}, form: REFUSED };
          setFailedArgs(null);
          setFailure(refused);
          announceFailure([refused.form, ...Object.values(refused.fields)]);
        } else {
          setFailedArgs(args);
          setFailure({ fields: {}, form: SAVE_FAILED });
          announceFailure([SAVE_FAILED]);
        }
      }
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
      }
    }
  };

  const errors = failure.fields;
  const overnight = draft.quietEnabled ? overnightLabel(draft.quietStart, draft.quietEnd) : null;
  const usingFallback = base.time_zone_source === "default" && !draft.timeZoneChosen;

  // Turning quiet hours on with no saved window starts from 22:00 to 07:00,
  // so the pickers always hold a time.
  const setQuiet = (quietEnabled: boolean) =>
    edit(["quietStart", "quietEnd"], {
      quietEnabled,
      ...(quietEnabled && parseTime(draft.quietStart) === null
        ? { quietStart: DEFAULT_QUIET_START }
        : {}),
      ...(quietEnabled && parseTime(draft.quietEnd) === null
        ? { quietEnd: DEFAULT_QUIET_END }
        : {}),
    });

  // Padding on both platforms keeps the fields and the dock above the
  // keyboard. Android draws edge to edge (DEC-17(2)), so the window no longer
  // resizes for the keyboard and the view has to make the room itself.
  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
      style={styles.root}
    >
      <StackScreen>
        <PushStatus />

        <GroupedSection title="Quiet hours">
          <GroupedRow
            title="Quiet hours"
            accessory={
              <Toggle
                label="Quiet hours"
                value={draft.quietEnabled}
                disabled={pending}
                onChange={setQuiet}
              />
            }
          />
          {draft.quietEnabled ? (
            <TimeRow
              title="From"
              label="Quiet hours start"
              value={draft.quietStart}
              fallback={DEFAULT_QUIET_START}
              disabled={pending}
              onChange={(quietStart) => edit(["quietStart", "quietEnd"], { quietStart })}
            />
          ) : null}
          {draft.quietEnabled ? (
            <TimeRow
              title="To"
              label="Quiet hours end"
              value={draft.quietEnd}
              fallback={DEFAULT_QUIET_END}
              disabled={pending}
              onChange={(quietEnd) => edit(["quietStart", "quietEnd"], { quietEnd })}
            />
          ) : null}
          <GroupedRow
            title="Urgent decisions still push"
            accessory={
              <Toggle
                label="Urgent decisions still push"
                value={draft.urgentOverride}
                disabled={pending}
                onChange={(urgentOverride) => edit([], { urgentOverride })}
              />
            }
          />
        </GroupedSection>
        <Notes
          errors={[errors.quietStart, errors.quietEnd]}
          lines={[QUIET_NOTE, overnight, draft.urgentOverride ? URGENT_ON : URGENT_OFF]}
        />

        <GroupedSection title="Daily digest">
          <TimeRow
            title="Deliver at"
            label="Digest time"
            value={draft.digestTime}
            fallback="09:00"
            disabled={pending}
            onChange={(digestTime) => edit(["digestTime"], { digestTime })}
          />
        </GroupedSection>
        <Notes
          errors={[errors.digestTime]}
          lines={["The digest arrives at this time each day when it has something to report."]}
        />

        <GroupedSection title="Agents">
          <GroupedRow
            title="Mark stale after"
            accessory={
              <View style={styles.threshold}>
                <TextInput
                  accessibilityLabel="Stale threshold in minutes"
                  editable={!pending}
                  inputAccessoryViewID={THRESHOLD_TOOLBAR}
                  keyboardType="number-pad"
                  maxLength={3}
                  onChangeText={(staleThreshold) =>
                    edit(["staleThresholdMinutes"], { staleThreshold })
                  }
                  placeholder="30"
                  placeholderTextColor={theme.textSecondary}
                  returnKeyType="done"
                  selectTextOnFocus
                  style={styles.thresholdInput}
                  value={draft.staleThreshold}
                />
                <AppText tone="secondary">min</AppText>
              </View>
            }
          />
        </GroupedSection>
        <Notes
          errors={[errors.staleThresholdMinutes]}
          lines={[
            "An agent with no status update for this many minutes is marked stale. From 5 to 240.",
          ]}
        />

        <GroupedSection title="Time zone">
          <GroupedRow
            title="Time zone"
            value={zoneName(draft.timeZone)}
            chevron
            accessibilityLabel={`Time zone, ${draft.timeZone}`}
            disabled={pending}
            onPress={() => setPicking(true)}
          />
        </GroupedSection>
        <Notes
          errors={[errors.timeZone]}
          lines={[
            "Quiet hours and the digest time use this time zone.",
            usingFallback ? FALLBACK_NOTE : null,
          ]}
        />
        <ZoneSheet
          visible={picking}
          selected={draft.timeZone}
          disabled={pending}
          onSelect={(timeZone) => edit(["timeZone"], { timeZone, timeZoneChosen: true })}
          onClose={() => setPicking(false)}
        />
      </StackScreen>
      <Dock>
        {failure.form === null ? null : (
          <AppText variant="footnote" tone="red" style={{ textAlign: "center" }}>
            {failure.form}
          </AppText>
        )}
        {saved ? (
          <View style={styles.status}>
            <Icon name="checkmark-circle" size={16} color={theme.green} />
            <AppText variant="footnote" tone="green">
              {SAVED}
            </AppText>
          </View>
        ) : null}
        <SaveControl
          label={pending ? "Saving..." : failedArgs !== null ? "Retry" : "Save settings"}
          disabled={pending}
          onSave={(update) => void save(update)}
        />
      </Dock>
      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={THRESHOLD_TOOLBAR}>
          <View style={styles.toolbar}>
            <HeaderButton label="Done" emphasis onPress={() => Keyboard.dismiss()} />
          </View>
        </InputAccessoryView>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function SettingsLoader() {
  const settings = useQuery(notifications.settings.getSettings, {});
  if (settings === undefined) {
    return <Loading label="Loading notification settings" />;
  }
  return <SettingsForm settings={settings} />;
}

export default function NotificationSettingsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Notifications" }} />
      <QueryErrorBoundary
        fallback={(_error, retry) => (
          <StackScreen>
            <EmptyState icon="cloud-offline" title="Could not load your notification settings.">
              <Button label="Try again" onPress={retry} />
            </EmptyState>
          </StackScreen>
        )}
      >
        <SettingsLoader />
      </QueryErrorBoundary>
    </>
  );
}
