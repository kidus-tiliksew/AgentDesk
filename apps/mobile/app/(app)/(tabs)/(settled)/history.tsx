import { useCallback, useState } from "react";
import { View } from "react-native";
import { Button } from "../../../../src/button";
import {
  HistoryFilters,
  SEARCH_DEBOUNCE_MS,
  type SettledState,
  useDebouncedValue,
} from "../../../../src/history-filters";
import {
  type HistoryArgs,
  HistoryList,
  HistoryLoadFailure,
  useHistoryDeletion,
} from "../../../../src/history-list";
import { QueryErrorBoundary } from "../../../../src/query-error-boundary";
import { spacing } from "../../../../src/theme";
import { LargeTitleScreen } from "../../../../src/ui/screen";
import { AppText } from "../../../../src/ui/text";

// component-mobile-app §Screens: the searchable history of settled decisions
// (req-mobile-app REQ-6), a tab root with a large title. The search text
// reaches `decisions/app:searchHistory` after it settles for
// SEARCH_DEBOUNCE_MS; the backend matches it against titles, bodies, answers,
// and notes (AC-6.1). The state and topic filters apply at once. Deleting a
// row asks for a confirmation in an action sheet and calls
// `decisions/app:remove` (AC-6.2).
export default function HistoryScreen() {
  const [text, setText] = useState("");
  const [state, setState] = useState<SettledState | null>(null);
  // Every topic seen in a loaded row this visit, plus any topic typed under
  // "Other topic". Kept across filter changes, so a narrowing filter does not
  // take the other chips away.
  const [topics, setTopics] = useState<string[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const deletion = useHistoryDeletion();

  const addTopics = useCallback((seen: string[]) => {
    setTopics((known) => {
      const added = seen.filter((topic) => !known.includes(topic));
      return added.length === 0 ? known : [...known, ...added];
    });
  }, []);

  const query = useDebouncedValue(text, SEARCH_DEBOUNCE_MS).trim();
  const args: HistoryArgs = {
    ...(query === "" ? {} : { query }),
    ...(state === null ? {} : { state }),
    ...(selectedTopic === null ? {} : { topic: selectedTopic }),
  };
  const filtered = query !== "" || state !== null || selectedTopic !== null;
  // Controls stay disabled while a deletion runs, so no new input remounts the
  // list and the failing row's message during the call.
  const busy = deletion.pendingId !== null;

  return (
    <LargeTitleScreen title="History">
      {/* Outside the query boundary, so the inputs stay usable while the list
          loads, is empty, or failed to load. */}
      <HistoryFilters
        text={text}
        onChangeText={setText}
        state={state}
        onSelectState={setState}
        topics={topics}
        selectedTopic={selectedTopic}
        onApplyTopic={(topic) => {
          addTopics([topic]);
          setSelectedTopic(topic);
        }}
        onSelectTopic={setSelectedTopic}
        disabled={busy}
      />
      {deletion.notice === null ? null : (
        <View style={{ paddingHorizontal: spacing.screen, paddingTop: 12 }}>
          <AppText variant="subhead" tone="secondary">
            {deletion.notice}
          </AppText>
        </View>
      )}
      <QueryErrorBoundary
        key={JSON.stringify(args)}
        fallback={(_error, retry) => (
          <HistoryLoadFailure>
            <Button label="Try again" onPress={retry} />
          </HistoryLoadFailure>
        )}
      >
        <HistoryList args={args} filtered={filtered} deletion={deletion} onTopics={addTopics} />
      </QueryErrorBoundary>
    </LargeTitleScreen>
  );
}
