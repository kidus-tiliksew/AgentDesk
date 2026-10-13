import { useMemo, useState } from "react";
import {
  AccessibilityInfo,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "./haptics";
import {
  deviceTimeZone,
  filterZones,
  isValidTimeZone,
  supportedTimeZones,
  ZONE_RULE,
  zoneChoices,
} from "./notification-settings";
import { HeaderButton } from "./rules/header-button";
import { makeStyles, radius, useTheme } from "./theme";
import { GroupedRow, GroupedSection } from "./ui/grouped";
import { Icon } from "./ui/icon";
import { AppText } from "./ui/text";

// The time zone picker of the notification settings: a sheet with a search
// field, the device zone and UTC as shortcuts, every zone the runtime lists,
// and a field for any other IANA name (prototype frame "Notification
// settings": "Time zone opens a searchable list"). Choosing any zone,
// including the one already saved, hands it to the form as the person's own
// choice and closes the sheet. Apple HIG Sheets: the title is centered and
// Cancel, on the leading side, closes the sheet without changing the zone;
// a pick is the sheet's confirming action, so there is no Done.

// The most zones the list draws at once; a search narrows the rest.
const VISIBLE_ZONES = 50;

const UTC = "UTC";

const useStyles = makeStyles((theme) => ({
  sheet: { backgroundColor: theme.background, flex: 1 },
  bar: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  // Equal sides keep the title centered on the sheet, whatever Cancel's
  // width.
  barSide: { alignItems: "flex-start", flex: 1 },
  title: { flexShrink: 1, textAlign: "center" },
  search: {
    alignItems: "center",
    backgroundColor: theme.fill,
    borderRadius: radius.small,
    flexDirection: "row",
    gap: 6,
    marginHorizontal: 16,
    paddingHorizontal: 10,
  },
  searchInput: { color: theme.text, flex: 1, fontSize: 17, minHeight: 44 },
  zone: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressed: { backgroundColor: theme.fill },
  zoneText: { flex: 1, gap: 2 },
  note: { paddingHorizontal: 32, paddingTop: 7 },
  customInput: { color: theme.text, fontSize: 17, minHeight: 46, paddingHorizontal: 16 },
}));

function ZoneRow({
  zone,
  device,
  selected,
  disabled,
  onPress,
}: {
  zone: string;
  device: boolean;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Time zone: ${device ? `${zone} (this device)` : zone}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.zone, pressed && styles.pressed]}
    >
      <View style={styles.zoneText}>
        <AppText>{zone.replace(/_/g, " ")}</AppText>
        {device ? (
          <AppText variant="footnote" tone="secondary">
            This device
          </AppText>
        ) : null}
      </View>
      {selected ? <Icon name="checkmark" size={20} color={theme.accent} /> : null}
    </Pressable>
  );
}

export function ZoneSheet({
  visible,
  selected,
  disabled,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected: string;
  disabled: boolean;
  onSelect: (zone: string) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const device = useMemo(() => deviceTimeZone(), []);
  const supported = useMemo(() => supportedTimeZones(), []);

  // With no search, the device zone and UTC lead as shortcuts and the list
  // below leaves them out, so each zone shows once.
  const searching = search.trim() !== "";
  const shortcuts = searching ? [] : [...new Set([...(device === null ? [] : [device]), UTC])];
  const matches = filterZones(zoneChoices({ selected, device, supported }), search).filter(
    (zone) => !shortcuts.includes(zone),
  );
  const shown = matches.slice(0, VISIBLE_ZONES);

  const close = () => {
    setSearch("");
    setCustom("");
    setCustomError(null);
    onClose();
  };

  const choose = (zone: string) => {
    onSelect(zone);
    close();
  };

  const applyCustom = () => {
    const zone = custom.trim();
    if (!isValidTimeZone(zone)) {
      // VoiceOver reads the error, which appears below the focused field.
      setCustomError(ZONE_RULE);
      haptic.error();
      AccessibilityInfo.announceForAccessibility(ZONE_RULE);
      return;
    }
    choose(zone);
  };

  const row = (zone: string) => (
    <ZoneRow
      key={zone}
      zone={zone}
      device={zone === device}
      selected={zone === selected}
      disabled={disabled}
      onPress={() => choose(zone)}
    />
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      {/* iOS draws the page sheet below the status bar; Android's modal
          covers the whole screen. */}
      <View style={[styles.sheet, { paddingTop: Platform.OS === "android" ? insets.top : 0 }]}>
        <View style={styles.bar}>
          <View style={styles.barSide}>
            <HeaderButton label="Cancel" onPress={close} />
          </View>
          <AppText accessibilityRole="header" variant="headline" style={styles.title}>
            Time zone
          </AppText>
          <View style={styles.barSide} />
        </View>
        <View style={styles.search}>
          <Icon name="search" size={17} color={theme.textSecondary} />
          <TextInput
            accessibilityLabel="Search time zones"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            editable={!disabled}
            onChangeText={setSearch}
            placeholder="Search, for example Berlin"
            placeholderTextColor={theme.textSecondary}
            style={styles.searchInput}
            value={search}
          />
        </View>
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          keyboardShouldPersistTaps="handled"
        >
          {shortcuts.length === 0 ? null : (
            <GroupedSection title="Suggested">{shortcuts.map(row)}</GroupedSection>
          )}
          {shown.length === 0 ? (
            <AppText variant="footnote" tone="secondary" style={styles.note}>
              No matching time zones.
            </AppText>
          ) : (
            <GroupedSection title={searching ? "Matches" : "All time zones"}>
              {shown.map(row)}
            </GroupedSection>
          )}
          {matches.length > shown.length ? (
            <AppText variant="footnote" tone="secondary" style={styles.note}>
              {`Showing ${shown.length} of ${matches.length} time zones. Search to narrow the list.`}
            </AppText>
          ) : null}
          <GroupedSection
            title="Other time zone"
            footer="Any IANA name, for example America/Bogota."
          >
            <TextInput
              accessibilityLabel="Other time zone"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!disabled}
              onChangeText={(text) => {
                setCustom(text);
                setCustomError(null);
              }}
              onSubmitEditing={applyCustom}
              placeholder="Region/City"
              placeholderTextColor={theme.textSecondary}
              returnKeyType="done"
              style={styles.customInput}
              value={custom}
            />
            <GroupedRow
              title="Use time zone"
              tone="accent"
              disabled={disabled}
              onPress={applyCustom}
            />
          </GroupedSection>
          {customError === null ? null : (
            <AppText variant="footnote" tone="red" style={styles.note}>
              {customError}
            </AppText>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
