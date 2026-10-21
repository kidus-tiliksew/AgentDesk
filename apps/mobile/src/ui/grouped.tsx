import { Children, Fragment, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { makeStyles, minTouchTarget, radius, spacing, useTheme } from "../theme";
import { Icon, type IconName } from "./icon";
import { AppText } from "./text";

const useStyles = makeStyles((theme) => ({
  label: { paddingHorizontal: 32, paddingTop: 22, paddingBottom: 7 },
  footer: { paddingHorizontal: 32, paddingTop: 7 },
  group: {
    backgroundColor: theme.card,
    borderRadius: radius.control,
    marginHorizontal: spacing.screen,
    overflow: "hidden",
  },
  separator: { backgroundColor: theme.separator, height: 0.5 },
  // Rows are at least 46 pt tall, and at least the 48 dp touch target on
  // Android (DEC-17(4)); see rowHeight below.
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressed: { backgroundColor: theme.fill },
  grow: { flex: 1, gap: 2 },
  iconTile: {
    alignItems: "center",
    borderRadius: 8,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  value: { alignItems: "center", flexDirection: "row", gap: 4, flexShrink: 1 },
}));

// A row's minimum height: 46 pt, raised to the smallest touch target where
// that is taller.
function rowHeight() {
  return { minHeight: Math.max(46, minTouchTarget()) };
}

// An iOS-style grouped list section: an optional uppercase label, rows on a
// rounded card with hairline separators, and an optional footnote.
export function GroupedSection({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  const styles = useStyles();
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View>
      {title === undefined ? (
        <View style={{ height: 18 }} />
      ) : (
        <AppText
          accessibilityRole="header"
          variant="footnote"
          tone="secondary"
          style={[styles.label, { textTransform: "uppercase" }]}
        >
          {title}
        </AppText>
      )}
      <View style={styles.group}>
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
          <Fragment key={index}>
            {index === 0 ? null : <View style={[styles.separator, { marginLeft: 16 }]} />}
            {row}
          </Fragment>
        ))}
      </View>
      {footer === undefined ? null : (
        <AppText variant="footnote" tone="secondary" style={styles.footer}>
          {footer}
        </AppText>
      )}
    </View>
  );
}

// One row of a grouped section. With `onPress` it is a button; `chevron`
// marks a row that opens another screen.
export function GroupedRow({
  title,
  subtitle,
  value,
  icon,
  chevron = false,
  onPress,
  tone = "default",
  accessory,
  accessibilityLabel,
  disabled = false,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  icon?: { name: IconName; color: string };
  chevron?: boolean;
  onPress?: () => void;
  tone?: "default" | "accent" | "destructive";
  accessory?: ReactNode;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const centered = tone !== "default" && icon === undefined && value === undefined;
  const content = (
    <>
      {icon === undefined ? null : (
        <View style={[styles.iconTile, { backgroundColor: icon.color }]}>
          <Icon name={icon.name} size={18} color="#ffffff" />
        </View>
      )}
      <View style={styles.grow}>
        <AppText
          tone={tone === "destructive" ? "red" : tone === "accent" ? "accent" : "primary"}
          style={centered ? { textAlign: "center" } : null}
        >
          {title}
        </AppText>
        {subtitle === undefined ? null : (
          <AppText variant="footnote" tone="secondary">
            {subtitle}
          </AppText>
        )}
      </View>
      {value === undefined && !chevron ? null : (
        <View style={styles.value}>
          {value === undefined ? null : (
            <AppText tone="secondary" numberOfLines={1}>
              {value}
            </AppText>
          )}
          {chevron ? <Icon name="chevron-forward" size={17} color={theme.textTertiary} /> : null}
        </View>
      )}
      {accessory}
    </>
  );
  if (onPress === undefined) {
    return (
      <View
        accessible={accessibilityLabel !== undefined}
        accessibilityLabel={accessibilityLabel}
        style={[styles.row, rowHeight()]}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        rowHeight(),
        pressed && styles.pressed,
        disabled && { opacity: 0.5 },
      ]}
    >
      {content}
    </Pressable>
  );
}
