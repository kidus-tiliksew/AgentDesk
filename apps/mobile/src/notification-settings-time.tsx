import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { Platform } from "react-native";
import { dateAsTime, timeAsDate } from "./notification-settings";
import { useTheme } from "./theme";
import { GroupedRow } from "./ui/grouped";

// One time row of the notification settings (prototype frame "Notification
// settings"): a title such as "From" with the native time picker. On iOS the
// compact picker is the row's accessory. Android has no inline picker, so the
// row shows the time and opens the system's time dialog on press. `label` is
// the accessible name, such as "Quiet hours start".
export function TimeRow({
  title,
  label,
  value,
  fallback,
  disabled,
  onChange,
}: {
  title: string;
  label: string;
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  const date = timeAsDate(value, fallback);

  if (Platform.OS === "android") {
    return (
      <GroupedRow
        title={title}
        value={dateAsTime(date)}
        accessibilityLabel={`${label}, ${dateAsTime(date)}`}
        disabled={disabled}
        onPress={() =>
          DateTimePickerAndroid.open({
            value: date,
            mode: "time",
            is24Hour: true,
            onValueChange: (_event, picked) => onChange(dateAsTime(picked)),
          })
        }
      />
    );
  }
  return (
    <GroupedRow
      title={title}
      accessory={
        <DateTimePicker
          accessibilityLabel={label}
          accentColor={theme.accent}
          disabled={disabled}
          display="compact"
          mode="time"
          onValueChange={(_event, picked) => onChange(dateAsTime(picked))}
          themeVariant={theme.scheme}
          value={date}
        />
      }
    />
  );
}
