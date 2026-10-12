import { errorCodeSchema } from "@agentdesk/contract";
import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { Stack } from "expo-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { notifications } from "../../../../../convex/notifications/refs";
import type { NotificationSettings } from "../../../../../convex/notifications/settings";
import { Button } from "../../../src/button";
import { Loading } from "../../../src/loading";
import {
  type Draft,
  deviceTimeZone,
  draftOf,
  type FieldErrors,
  filterZones,
  isSettingsField,
  isValidTimeZone,
  overnightLabel,
  refusalMessage,
  type SettingsField,
  sameDraft,
  sameSettings,
  supportedTimeZones,
  type UpdateArgs,
  validateDraft,
  ZONE_RULE,
  zoneChoices,
} from "../../../src/notification-settings";
import { errorData, QueryErrorBoundary } from "../../../src/query-error-boundary";
import { styles } from "../../../src/styles";

// component-mobile-app §Screens, notification settings: quiet hours, urgent
// override, digest time, time zone, and stale threshold (req-mobile-app
// REQ-5; req-notification-rules REQ-5, REQ-6; req-agent-status AC-3.1). The
// screen reads `notifications/settings:getSettings` and saves the whole form
// with one `updateSettings` call. The backend checks every field again.

type Update = (args: UpdateArgs) => Promise<NotificationSettings>;

const SAVE_FAILED = "Could not save your settings. Check your connection and try again.";
const REFUSED = "AgentDesk refused these settings. Check the fields and save again.";
const SAVED = "Settings saved.";

// The most zones the picker draws at once; a search narrows the rest.
const VISIBLE_ZONES = 20;

function Choice({
  group,
  label,
  selected,
  disabled,
  onPress,
}: {
  group: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${group}: ${label}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={selected ? styles.chipTextSelected : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function OnOff({
  group,
  value,
  disabled,
  onChange,
}: {
  group: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.rowMeta}>
      <Choice
        group={group}
        label="Off"
        selected={!value}
        disabled={disabled}
        onPress={() => onChange(false)}
      />
      <Choice
        group={group}
        label="On"
        selected={value}
        disabled={disabled}
        onPress={() => onChange(true)}
      />
    </View>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  return message === undefined ? null : <Text style={styles.error}>{message}</Text>;
}

function TimeField({
  label,
  value,
  editable,
  placeholder,
  error,
  onChange,
}: {
  label: string;
  value: string;
  editable: boolean;
  placeholder: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityState={{ disabled: !editable }}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        onChangeText={onChange}
        placeholder={placeholder}
        style={styles.input}
        value={value}
      />
      <FieldError message={error} />
    </View>
  );
}

// The searchable zone list and the custom zone field. The device zone comes
// first and is marked; choosing any zone, including the one already saved,
// sends it as the person's own choice.
function ZonePicker({
  selected,
  disabled,
  error,
  onSelect,
}: {
  selected: string;
  disabled: boolean;
  error: string | undefined;
  onSelect: (zone: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const device = useMemo(() => deviceTimeZone(), []);
  const supported = useMemo(() => supportedTimeZones(), []);
  const choices = zoneChoices({ selected, device, supported });
  const matches = filterZones(choices, search);
  const shown = matches.slice(0, VISIBLE_ZONES);

  const applyCustom = () => {
    const zone = custom.trim();
    if (!isValidTimeZone(zone)) {
      setCustomError(ZONE_RULE);
      return;
    }
    setCustomError(null);
    setCustom("");
    onSelect(zone);
  };

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Time zone</Text>
      <Text style={styles.line}>{`Selected: ${selected}`}</Text>
      <TextInput
        accessibilityLabel="Search time zones"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        onChangeText={setSearch}
        placeholder="Search, for example Berlin"
        style={styles.input}
        value={search}
      />
      <View style={styles.rowMeta}>
        {shown.map((zone) => (
          <Choice
            key={zone}
            group="Time zone"
            label={zone === device ? `${zone} (this device)` : zone}
            selected={zone === selected}
            disabled={disabled}
            onPress={() => onSelect(zone)}
          />
        ))}
      </View>
      {matches.length === 0 ? <Text style={styles.meta}>No matching time zones.</Text> : null}
      {matches.length > shown.length ? (
        <Text style={styles.meta}>
          {`Showing ${shown.length} of ${matches.length} time zones. Search to narrow the list.`}
        </Text>
      ) : null}
      <Text style={styles.fieldLabel}>Other time zone</Text>
      <View style={styles.filterRow}>
        <TextInput
          accessibilityLabel="Other time zone"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          onChangeText={(text) => {
            setCustom(text);
            setCustomError(null);
          }}
          placeholder="IANA name, for example America/Bogota"
          style={[styles.input, styles.filterInput]}
          value={custom}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={applyCustom}
        >
          <Text style={styles.link}>Use time zone</Text>
        </Pressable>
      </View>
      {customError === null ? null : <Text style={styles.error}>{customError}</Text>}
      <FieldError message={error} />
    </View>
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
  return <Button label={label} onPress={() => onSave(update)} disabled={disabled} />;
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
      }
    } catch (error) {
      if (live()) {
        const data = errorData(error);
        if (data?.code === errorCodeSchema.enum.invalid) {
          setFailedArgs(null);
          setFailure(
            isSettingsField(data.field)
              ? { fields: { [data.field]: refusalMessage(data.field) }, form: null }
              : { fields: {}, form: REFUSED },
          );
        } else {
          setFailedArgs(args);
          setFailure({ fields: {}, form: SAVE_FAILED });
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

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.heading}>Quiet hours</Text>
      <Text style={styles.line}>
        During quiet hours, notifications that would push go to the daily digest instead.
      </Text>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Quiet hours</Text>
        <OnOff
          group="Quiet hours"
          value={draft.quietEnabled}
          disabled={pending}
          onChange={(quietEnabled) => edit(["quietStart", "quietEnd"], { quietEnabled })}
        />
      </View>
      <TimeField
        label="Quiet hours start"
        value={draft.quietStart}
        editable={draft.quietEnabled && !pending}
        placeholder="22:00"
        error={errors.quietStart}
        onChange={(quietStart) => edit(["quietStart", "quietEnd"], { quietStart })}
      />
      <TimeField
        label="Quiet hours end"
        value={draft.quietEnd}
        editable={draft.quietEnabled && !pending}
        placeholder="07:00"
        error={errors.quietEnd}
        onChange={(quietEnd) => edit(["quietStart", "quietEnd"], { quietEnd })}
      />
      {overnight === null ? null : <Text style={styles.meta}>{overnight}</Text>}

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Urgent override</Text>
        <OnOff
          group="Urgent override"
          value={draft.urgentOverride}
          disabled={pending}
          onChange={(urgentOverride) => edit([], { urgentOverride })}
        />
        <Text style={styles.meta}>
          {draft.urgentOverride
            ? "Urgent decisions still push during quiet hours."
            : "Urgent decisions go to the digest during quiet hours, like everything else."}
        </Text>
      </View>

      <Text style={styles.heading}>Daily digest</Text>
      <TimeField
        label="Digest time"
        value={draft.digestTime}
        editable={!pending}
        placeholder="09:00"
        error={errors.digestTime}
        onChange={(digestTime) => edit(["digestTime"], { digestTime })}
      />
      <Text style={styles.meta}>
        The digest arrives at this time each day when it has something to report.
      </Text>

      <Text style={styles.heading}>Time zone</Text>
      <Text style={styles.meta}>Quiet hours and the digest time use this time zone.</Text>
      {usingFallback ? (
        <Text style={styles.meta}>
          No time zone has been recorded from this device yet, so AgentDesk uses UTC.
        </Text>
      ) : null}
      <ZonePicker
        selected={draft.timeZone}
        disabled={pending}
        error={errors.timeZone}
        onSelect={(timeZone) => edit(["timeZone"], { timeZone, timeZoneChosen: true })}
      />

      <Text style={styles.heading}>Stale agents</Text>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Stale threshold in minutes</Text>
        <TextInput
          accessibilityLabel="Stale threshold in minutes"
          editable={!pending}
          keyboardType="number-pad"
          onChangeText={(staleThreshold) => edit(["staleThresholdMinutes"], { staleThreshold })}
          placeholder="30"
          style={styles.input}
          value={draft.staleThreshold}
        />
        <Text style={styles.meta}>
          An agent with no status update for this many minutes is marked stale. From 5 to 240.
        </Text>
        <FieldError message={errors.staleThresholdMinutes} />
      </View>

      {failure.form === null ? null : <Text style={styles.error}>{failure.form}</Text>}
      {saved ? <Text style={styles.line}>{SAVED}</Text> : null}
      <SaveControl
        label={pending ? "Saving..." : failedArgs !== null ? "Retry" : "Save settings"}
        disabled={pending}
        onSave={(update) => void save(update)}
      />
    </ScrollView>
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
          <View style={styles.centered}>
            <Text style={styles.error}>Could not load your notification settings.</Text>
            <Button label="Try again" onPress={retry} />
          </View>
        )}
      >
        <SettingsLoader />
      </QueryErrorBoundary>
    </>
  );
}
