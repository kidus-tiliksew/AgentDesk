import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, Switch, TextInput, View } from "react-native";
import { Button } from "../button";
import { haptic } from "../haptics";
import { makeStyles, spacing, useTheme } from "../theme";
import { GroupedSection } from "../ui/grouped";
import { Icon } from "../ui/icon";
import { AppText } from "../ui/text";
import {
  type CreateArgs,
  createFailure,
  type Draft,
  type Errors,
  type Field,
  HARNESSES,
  type HarnessId,
  INITIAL_DRAFT,
  validateDraft,
} from "./validation";

// The create form (component-mobile-app §Install keys; req-install-keys
// AC-1.2, AC-1.3): a label, the harnesses the key may connect, an expiry in
// days, a machine limit, and whether the key is ephemeral, with an idle limit
// only for an ephemeral key. Create checks every field and names each bad
// one under it before anything is sent; the backend checks them again and
// a field it refuses is named the same way. While a request runs Create
// does nothing, so one press sends one request.

const useStyles = makeStyles((theme) => ({
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  rowLabel: { flex: 1 },
  input: {
    color: theme.text,
    flex: 1,
    fontSize: 17,
    paddingVertical: 4,
    textAlign: "right",
  },
  labelInput: { color: theme.text, fontSize: 17, minHeight: 46, paddingHorizontal: 16 },
  errors: { gap: 2, paddingHorizontal: 32, paddingTop: 7 },
  submit: { gap: 8, marginHorizontal: spacing.screen, marginTop: 18 },
}));

function FieldError({ message }: { message: string | undefined }) {
  const styles = useStyles();
  if (message === undefined) {
    return null;
  }
  return (
    <View style={styles.errors}>
      <AppText variant="footnote" tone="red">
        {message}
      </AppText>
    </View>
  );
}

function NumberRow({
  title,
  label,
  unit,
  value,
  disabled,
  onChange,
}: {
  title: string;
  label: string;
  unit: string;
  value: string;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <AppText style={styles.rowLabel}>{title}</AppText>
      <TextInput
        accessibilityLabel={label}
        // TalkBack reads an edit box's value in place of its label, so on
        // Android the hint names the field.
        accessibilityHint={Platform.OS === "android" ? label : undefined}
        editable={!disabled}
        keyboardType="number-pad"
        maxLength={4}
        onChangeText={onChange}
        placeholderTextColor={theme.textSecondary}
        selectTextOnFocus
        style={styles.input}
        value={value}
      />
      <AppText tone="secondary">{unit}</AppText>
    </View>
  );
}

function HarnessRow({
  id,
  name,
  checked,
  disabled,
  onToggle,
}: {
  id: HarnessId;
  name: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: HarnessId) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={name}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onToggle(id)}
      style={styles.row}
    >
      <AppText style={styles.rowLabel}>{name}</AppText>
      {checked ? <Icon name="checkmark" size={20} color={theme.accent} /> : null}
    </Pressable>
  );
}

export function CreateForm({ onCreate }: { onCreate: (args: CreateArgs) => Promise<void> }) {
  const styles = useStyles();
  const theme = useTheme();
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set synchronously, so a second press before the re-render sends nothing.
  const pending = useRef(false);
  // Cleared on unmount, so a call that settles later changes nothing.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const edit = (field: Field | null, patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFailure(null);
    if (field !== null) {
      setErrors((current) => {
        const { [field]: _cleared, ...rest } = current;
        return rest;
      });
    }
  };

  const toggleHarness = (id: HarnessId) => {
    const harnesses = draft.harnesses.includes(id)
      ? draft.harnesses.filter((harness) => harness !== id)
      : [...draft.harnesses, id];
    edit("harnesses", { harnesses });
  };

  const create = async () => {
    if (pending.current) {
      return;
    }
    const checked = validateDraft(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      haptic.error();
      AccessibilityInfo.announceForAccessibility(Object.values(checked.errors).join(" "));
      return;
    }
    pending.current = true;
    setBusy(true);
    setErrors({});
    setFailure(null);
    try {
      await onCreate(checked.args);
      if (mounted.current) {
        setDraft(INITIAL_DRAFT);
      }
    } catch (error) {
      const result = createFailure(error);
      haptic.error();
      AccessibilityInfo.announceForAccessibility(result.message);
      if (mounted.current) {
        if (result.field === null) {
          setFailure(result.message);
        } else {
          setErrors({ [result.field]: result.message });
        }
      }
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  };

  return (
    <View>
      <GroupedSection title="New install key">
        <TextInput
          accessibilityLabel="Label"
          accessibilityHint={Platform.OS === "android" ? "Label" : undefined}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          onChangeText={(label) => edit("label", { label })}
          placeholder="Label, e.g. CI sandboxes"
          placeholderTextColor={theme.textSecondary}
          style={styles.labelInput}
          value={draft.label}
        />
      </GroupedSection>
      <FieldError message={errors.label} />

      <GroupedSection title="Harnesses">
        {HARNESSES.map((harness) => (
          <HarnessRow
            key={harness.id}
            id={harness.id}
            name={harness.name}
            checked={draft.harnesses.includes(harness.id)}
            disabled={busy}
            onToggle={toggleHarness}
          />
        ))}
      </GroupedSection>
      <FieldError message={errors.harnesses} />

      <GroupedSection>
        <NumberRow
          title="Expires after"
          label="Expiry in days"
          unit="days"
          value={draft.expiresInDays}
          disabled={busy}
          onChange={(expiresInDays) => edit("expiresInDays", { expiresInDays })}
        />
        <NumberRow
          title="Machine limit"
          label="Machine limit"
          unit="machines"
          value={draft.machineLimit}
          disabled={busy}
          onChange={(machineLimit) => edit("machineLimit", { machineLimit })}
        />
      </GroupedSection>
      <FieldError message={errors.expiresInDays} />
      <FieldError message={errors.machineLimit} />

      <GroupedSection
        footer={
          draft.ephemeral
            ? "A connection made with this key ends by itself after the idle limit without a request."
            : "Turn on for short-lived sandboxes, so their connections end when they go quiet."
        }
      >
        <View style={styles.row}>
          <AppText style={styles.rowLabel}>Ephemeral</AppText>
          <Switch
            accessibilityLabel="Ephemeral"
            accessibilityState={{ checked: draft.ephemeral, disabled: busy }}
            disabled={busy}
            onValueChange={(ephemeral) => edit("idleLimitMinutes", { ephemeral })}
            trackColor={{ true: theme.green }}
            value={draft.ephemeral}
          />
        </View>
        {draft.ephemeral ? (
          <NumberRow
            title="Idle limit"
            label="Idle limit in minutes"
            unit="min"
            value={draft.idleLimitMinutes}
            disabled={busy}
            onChange={(idleLimitMinutes) => edit("idleLimitMinutes", { idleLimitMinutes })}
          />
        ) : null}
      </GroupedSection>
      <FieldError message={draft.ephemeral ? errors.idleLimitMinutes : undefined} />

      <View style={styles.submit}>
        {failure === null ? null : (
          <AppText variant="footnote" tone="red">
            {failure}
          </AppText>
        )}
        <Button
          label={busy ? "Creating..." : "Create install key"}
          disabled={busy}
          onPress={() => void create()}
        />
      </View>
    </View>
  );
}
