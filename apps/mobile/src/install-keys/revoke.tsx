import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Switch, View } from "react-native";
import { identity } from "../../../../convex/identity/refs";
import { Button } from "../button";
import { haptic } from "../haptics";
import { makeStyles, radius, useTheme } from "../theme";
import { AppText } from "../ui/text";
import { type InstallKey, revokeConnectionsLabel } from "./format";

// Revoking one install key (component-mobile-app §Install keys;
// req-install-keys AC-3.2). Its next installer run is refused. The switch,
// off by default, also disconnects the machines the key connected; its label
// carries the backend's `machinesConnected`, which follows enrollments and
// ended connections while the panel is open. The panel owns the
// `revokeInstallKey` hook, so the screen binds the mutation only when a
// person asks to revoke.

export const REVOKE_NOTE =
  "Machines can't connect with this key again. Machines it already connected stay connected unless you also disconnect them.";

export function revokeFailure(label: string): string {
  return `Could not revoke ${label}. Try again.`;
}

const useStyles = makeStyles((theme) => ({
  panel: {
    backgroundColor: theme.fill,
    borderRadius: radius.small,
    gap: 10,
    marginTop: 10,
    padding: 12,
  },
  toggle: { alignItems: "center", flexDirection: "row", gap: 12 },
  toggleLabel: { flex: 1 },
  actions: { flexDirection: "row", gap: 10 },
}));

export function RevokePanel({
  installKey,
  onClose,
}: {
  installKey: InstallKey;
  onClose: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const revokeInstallKey = useMutation(identity.installKeys.revokeInstallKey);
  const [revokeConnections, setRevokeConnections] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
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

  const label = revokeConnectionsLabel(installKey.machinesConnected);

  const revoke = async () => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await revokeInstallKey({ installKeyId: installKey.installKeyId, revokeConnections });
      // Apple HIG Playing haptics: confirm a significant action's outcome.
      // The key leaves the list with the query, so VoiceOver hears why.
      haptic.success();
      AccessibilityInfo.announceForAccessibility(`Revoked ${installKey.label}`);
      if (mounted.current) {
        onClose();
      }
    } catch {
      const message = revokeFailure(installKey.label);
      haptic.error();
      AccessibilityInfo.announceForAccessibility(message);
      if (mounted.current) {
        setFailure(message);
      }
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  };

  return (
    <View style={styles.panel}>
      <AppText variant="subhead" weight="600" accessibilityRole="header">
        {`Revoke ${installKey.label}?`}
      </AppText>
      <AppText variant="footnote" tone="secondary">
        {REVOKE_NOTE}
      </AppText>
      <View style={styles.toggle}>
        <AppText variant="subhead" style={styles.toggleLabel}>
          {label}
        </AppText>
        <Switch
          accessibilityLabel={label}
          accessibilityState={{ checked: revokeConnections, disabled: busy }}
          disabled={busy}
          onValueChange={setRevokeConnections}
          trackColor={{ true: theme.red }}
          value={revokeConnections}
        />
      </View>
      {failure === null ? null : (
        <AppText variant="footnote" tone="red">
          {failure}
        </AppText>
      )}
      <View style={styles.actions}>
        <Button label="Cancel" variant="secondary" grow disabled={busy} onPress={onClose} />
        <Button
          label={busy ? "Revoking..." : "Revoke key"}
          variant="destructive"
          grow
          disabled={busy}
          onPress={() => void revoke()}
        />
      </View>
    </View>
  );
}
