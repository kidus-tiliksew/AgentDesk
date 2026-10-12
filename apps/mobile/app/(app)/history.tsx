import { Stack } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../src/button";
import {
  HistoryFilters,
  SEARCH_DEBOUNCE_MS,
  type SettledState,
  useDebouncedValue,
} from "../../src/history-filters";
import { type HistoryArgs, HistoryList, useHistoryDeletion } from "../../src/history-list";
import { QueryErrorBoundary } from "../../src/query-error-boundary";
import { styles } from "../../src/styles";

// component-mobile-app §Screens: the searchable history of settled decisions
// (req-mobile-app REQ-6). The search text reaches `decisions/app:searchHistory`
// after it settles for SEARCH_DEBOUNCE_MS; the backend matches it against
// titles, bodies, answers, and notes (AC-6.1). The state and topic filters
// apply at once. Deleting a row asks for a confirmation and calls
// `decisions/app:remove` (AC-6.2).
export default function HistoryScreen() {
  const [text, setText] = useState("");
  const [state, setState] = useState<SettledState | null>(null);
  const [enteredTopic, setEnteredTopic] = useState<string | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const deletion = useHistoryDeletion();

  const query = useDebouncedValue(text, SEARCH_DEBOUNCE_MS).trim();
  const args: HistoryArgs = {
    ...(query === "" ? {} : { query }),
    ...(state === null ? {} : { state }),
    ...(selectedTopic === null ? {} : { topic: selectedTopic }),
  };
  const filtered = query !== "" || state !== null || selectedTopic !== null;
  // Controls stay disabled while a deletion runs, so no new input remounts the
  // list and its confirmation during the call.
  const busy = deletion.pendingId !== null;

  return (
    <>
      <Stack.Screen options={{ title: "History" }} />
      {/* Outside the query boundary, so the inputs stay usable while the list
          loads, is empty, or failed to load. */}
      <HistoryFilters
        text={text}
        onChangeText={setText}
        state={state}
        onSelectState={setState}
        enteredTopic={enteredTopic}
        selectedTopic={selectedTopic}
        onApplyTopic={(topic) => {
          setEnteredTopic(topic);
          setSelectedTopic(topic);
        }}
        onSelectTopic={setSelectedTopic}
        disabled={busy}
      />
      {deletion.notice === null ? null : <Text style={styles.notice}>{deletion.notice}</Text>}
      <QueryErrorBoundary
        key={JSON.stringify(args)}
        fallback={(_error, retry) => (
          <View style={styles.centered}>
            <Text style={styles.error}>Could not load your history.</Text>
            <Button label="Try again" onPress={retry} />
          </View>
        )}
      >
        <HistoryList args={args} filtered={filtered} deletion={deletion} />
      </QueryErrorBoundary>
    </>
  );
}
