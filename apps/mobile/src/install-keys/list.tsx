import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { View } from "react-native";
import { identity } from "../../../../convex/identity/refs";
import { Button } from "../button";
import { QueryErrorBoundary } from "../query-error-boundary";
import { makeStyles } from "../theme";
import { GroupedRow, GroupedSection } from "../ui/grouped";
import { Pill } from "../ui/pill";
import { AppText } from "../ui/text";
import { useScreenClock } from "../use-screen-clock";
import {
  datesLine,
  harnessList,
  type InstallKey,
  isExpired,
  lifetimeLine,
  spokenKeySummary,
  usageLine,
} from "./format";

// The signed-in person's install keys from the reactive
// `identity/installKeys:listInstallKeys` (component-mobile-app §Install keys;
// req-install-keys AC-3.1). Settings → Connections and the install keys
// screen both render these rows. A revoked key leaves the list when the
// backend commits the revocation; no screen removes a row itself.

export const INSTALL_KEYS_ROUTE = "/settings/install-keys";
export const LOAD_FAILURE = "Could not load your install keys.";
export const NO_KEYS = "No install keys";

const useStyles = makeStyles(() => ({
  row: { gap: 2, paddingHorizontal: 16, paddingVertical: 11 },
  title: { alignItems: "center", flexDirection: "row", gap: 8 },
  label: { flexShrink: 1 },
  failed: { alignItems: "flex-start", gap: 8, paddingHorizontal: 16, paddingVertical: 11 },
}));

// One key: its label, an Expired marker once its expiry has passed, its
// harnesses and lifetime, its dates, and its machines and last use.
// VoiceOver reads the row as one element. `action` sits under the facts, so
// it is reached as a separate element.
export function InstallKeyRow({
  installKey,
  now,
  action,
}: {
  installKey: InstallKey;
  now: number;
  action?: ReactNode;
}) {
  const styles = useStyles();
  const expired = isExpired(installKey, now);
  return (
    <View style={styles.row}>
      <View
        accessible
        accessibilityLabel={`Install key ${installKey.label}`}
        accessibilityValue={{ text: spokenKeySummary(installKey, now) }}
      >
        <View style={styles.title}>
          <AppText weight="600" style={styles.label}>
            {installKey.label}
          </AppText>
          {expired ? <Pill label="Expired" tone="red" /> : null}
        </View>
        <AppText variant="footnote" tone="secondary">
          {`${harnessList(installKey)} · ${lifetimeLine(installKey)}`}
        </AppText>
        <AppText variant="footnote" tone="secondary">
          {datesLine(installKey, now)}
        </AppText>
        <AppText variant="footnote" tone="secondary">
          {usageLine(installKey, now)}
        </AppText>
      </View>
      {action}
    </View>
  );
}

// Reads the keys. `undefined` while the query loads.
export function useInstallKeys(): InstallKey[] | undefined {
  return useQuery(identity.installKeys.listInstallKeys, {});
}

function ManageRow() {
  const router = useRouter();
  return (
    <GroupedRow
      title="Manage install keys"
      tone="accent"
      chevron
      onPress={() => router.push(INSTALL_KEYS_ROUTE)}
    />
  );
}

// Settings → Connections' section below the connections: the keys and a row
// that opens the install keys screen. The section has its own query
// boundary, so the row opens the screen whether the connections load, are
// empty, or failed, and whether the keys load or failed.
export function InstallKeysSection() {
  const styles = useStyles();
  return (
    <QueryErrorBoundary
      fallback={(_error, retry) => (
        <GroupedSection title="Install keys">
          <View style={styles.failed}>
            <AppText tone="red">{LOAD_FAILURE}</AppText>
            <Button label="Try again" variant="secondary" size="small" onPress={retry} />
          </View>
          <ManageRow />
        </GroupedSection>
      )}
    >
      <KeysGroup />
    </QueryErrorBoundary>
  );
}

const FOOTER = "An install key connects new machines without a code from this phone.";

// The rows are direct children of the section, so each gets its separator.
function KeysGroup() {
  const keys = useInstallKeys();
  const now = useScreenClock();
  let rows: ReactNode[];
  if (keys === undefined) {
    rows = [<GroupedRow key="loading" title="Loading install keys" />];
  } else if (keys.length === 0) {
    rows = [<GroupedRow key="empty" title={NO_KEYS} />];
  } else {
    rows = keys.map((key) => <InstallKeyRow key={key.installKeyId} installKey={key} now={now} />);
  }
  return (
    <GroupedSection title="Install keys" footer={FOOTER}>
      {rows}
      <ManageRow />
    </GroupedSection>
  );
}
