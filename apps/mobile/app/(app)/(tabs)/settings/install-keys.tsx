import { useMutation } from "convex/react";
import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import { identity } from "../../../../../../convex/identity/refs";
import { Button } from "../../../../src/button";
import { haptic } from "../../../../src/haptics";
import { CreateForm } from "../../../../src/install-keys/form";
import type { InstallKey } from "../../../../src/install-keys/format";
import {
  InstallKeyRow,
  LOAD_FAILURE,
  NO_KEYS,
  useInstallKeys,
} from "../../../../src/install-keys/list";
import { RevokePanel } from "../../../../src/install-keys/revoke";
import { SecretCard } from "../../../../src/install-keys/secret";
import type { CreateArgs } from "../../../../src/install-keys/validation";
import { QueryErrorBoundary } from "../../../../src/query-error-boundary";
import { makeStyles } from "../../../../src/theme";
import { GroupedRow, GroupedSection } from "../../../../src/ui/grouped";
import { StackScreen } from "../../../../src/ui/screen";
import { AppText } from "../../../../src/ui/text";
import { useScreenClock } from "../../../../src/use-screen-clock";

// component-mobile-app §Install keys: the person's install keys, the form
// that creates one, the new key's secret shown once, and revocation
// (req-install-keys REQ-1, REQ-3). Settings → Connections opens it.
//
// The secret lives only in this screen's state (AC-1.1). It is cleared when
// the screen loses focus as well as when it unmounts, because a tab's stack
// keeps a screen mounted under the one pushed over it and while another tab
// is shown. A create that settles after the person left is dropped: its key
// is listed, and its secret is never shown. The secret never enters route
// params, storage, logs, analytics, or error reports.

type Created = { label: string; secret: string };

const useStyles = makeStyles(() => ({
  failed: { alignItems: "flex-start", gap: 8, paddingHorizontal: 16, paddingVertical: 11 },
  revoke: { alignSelf: "flex-start", marginTop: 8 },
}));

// The listed keys, each with Revoke, which opens the revoke panel under its
// key. One panel is open at a time. A key revoked elsewhere leaves the list
// with its panel.
function KeyList() {
  const styles = useStyles();
  const keys = useInstallKeys();
  const now = useScreenClock();
  const [revokingId, setRevokingId] = useState<InstallKey["installKeyId"] | null>(null);

  if (keys === undefined) {
    return (
      <GroupedSection title="Install keys">
        <GroupedRow title="Loading install keys" />
      </GroupedSection>
    );
  }
  if (keys.length === 0) {
    return (
      <GroupedSection title="Install keys">
        <GroupedRow title={NO_KEYS} subtitle="Create one below for your cloud sandboxes." />
      </GroupedSection>
    );
  }
  return (
    <GroupedSection title="Install keys">
      {keys.map((key) => (
        <InstallKeyRow
          key={key.installKeyId}
          installKey={key}
          now={now}
          action={
            revokingId === key.installKeyId ? (
              <RevokePanel installKey={key} onClose={() => setRevokingId(null)} />
            ) : (
              <View style={styles.revoke}>
                <Button
                  label="Revoke"
                  variant="destructive"
                  size="small"
                  accessibilityLabel={`Revoke ${key.label}`}
                  onPress={() => setRevokingId(key.installKeyId)}
                />
              </View>
            )
          }
        />
      ))}
    </GroupedSection>
  );
}

export default function InstallKeysScreen() {
  const styles = useStyles();
  const createInstallKey = useMutation(identity.installKeys.createInstallKey);
  const [created, setCreated] = useState<Created | null>(null);
  // Counts departures. A create compares the count it started under with
  // the count when it settles, so a response after the person left shows
  // nothing.
  const departures = useRef(0);

  useFocusEffect(
    useCallback(
      () => () => {
        departures.current += 1;
        setCreated(null);
      },
      [],
    ),
  );
  useEffect(
    () => () => {
      departures.current += 1;
    },
    [],
  );

  const create = async (args: CreateArgs) => {
    const started = departures.current;
    const result = await createInstallKey(args);
    if (departures.current !== started) {
      return;
    }
    haptic.success();
    AccessibilityInfo.announceForAccessibility(
      `${args.label} created. Copy the key now; it can't be shown again.`,
    );
    setCreated({ label: args.label, secret: result.secret });
  };

  return (
    <>
      <Stack.Screen options={{ title: "Install keys" }} />
      <StackScreen>
        {created === null ? null : (
          <SecretCard
            label={created.label}
            secret={created.secret}
            onDone={() => setCreated(null)}
          />
        )}
        <QueryErrorBoundary
          fallback={(_error, retry) => (
            <GroupedSection title="Install keys">
              <View style={styles.failed}>
                <AppText tone="red">{LOAD_FAILURE}</AppText>
                <Button label="Try again" variant="secondary" size="small" onPress={retry} />
              </View>
            </GroupedSection>
          )}
        >
          <KeyList />
        </QueryErrorBoundary>
        {created === null ? <CreateForm onCreate={create} /> : null}
      </StackScreen>
    </>
  );
}
