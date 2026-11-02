/** @jsxImportSource react */
import {
  createStaticSource,
  Typeahead,
  TypeaheadItem,
  type SearchableItem,
  type SearchSource,
} from '@astryxdesign/core/Typeahead';
import { useMemo, useState } from 'react';

export type SearchSuggestion = Readonly<{
  id: string;
  label: string;
  keywords?: ReadonlyArray<string | null | undefined>;
  description?: string;
}>;

type SearchItem = SearchableItem<{
  keywords: ReadonlyArray<string>;
  description?: string;
}>;
const noSuggestions: ReadonlyArray<string | SearchSuggestion | null | undefined> = [];

export function SearchTypeahead({
  label,
  onChange,
  onSelect,
  onClear,
  suggestions = noSuggestions,
  remoteSearch,
  initialValue = '',
  initialSelection,
  width = 320,
}: {
  label: string;
  onChange: (value: string) => void;
  onSelect?: (id: string) => void;
  onClear?: () => void;
  suggestions?: ReadonlyArray<string | SearchSuggestion | null | undefined>;
  remoteSearch?: (query: string) => Promise<ReadonlyArray<SearchSuggestion>>;
  initialValue?: string;
  initialSelection?: SearchSuggestion;
  width?: number;
}) {
  const items = useMemo(() => {
    return searchItems(suggestions);
  }, [suggestions]);
  const source = useMemo<SearchSource<SearchItem>>(
    () =>
      remoteSearch
        ? {
            bootstrap: () => [],
            search: async (query: string) => searchItems(await remoteSearch(query)),
          }
        : createStaticSource(items, {
            keywords: (item: SearchItem) => [...(item.auxiliaryData?.keywords ?? [])],
          }),
    [items, remoteSearch],
  );
  const [selected, setSelected] = useState<SearchItem | null>(() =>
    initialValue
      ? (items.find((item) => item.id === initialValue) ??
        (initialSelection?.id === initialValue
          ? searchItems([initialSelection])[0]
          : undefined) ?? {
          id: initialValue,
          label: initialValue,
        })
      : null,
  );

  return (
    <Typeahead
      label={label}
      isLabelHidden
      placeholder={label}
      searchSource={source}
      value={selected}
      renderItem={(item: SearchItem) => (
        <TypeaheadItem item={item} description={item.auxiliaryData?.description} />
      )}
      onChange={(item: SearchItem | null) => {
        setSelected(item);
        onChange(item?.id ?? '');
        if (item) {
          onSelect?.(item.id);
        } else {
          onClear?.();
        }
      }}
      onChangeQuery={(query: string) => {
        setSelected(null);
        onChange(query);
      }}
      hasEntriesOnFocus={!remoteSearch}
      hasClear
      minQueryLength={remoteSearch ? 2 : 1}
      debounceMs={remoteSearch ? 200 : 0}
      width={width}
      emptySearchText={
        remoteSearch ? 'No matching results.' : 'No suggestions. Search for any text.'
      }
    />
  );
}

function searchItems(suggestions: ReadonlyArray<string | SearchSuggestion | null | undefined>) {
  const byId = new Map<string, SearchItem>();
  for (const suggestion of suggestions) {
    if (!suggestion) {
      continue;
    }
    const item: SearchItem =
      typeof suggestion === 'string'
        ? { id: suggestion, label: suggestion, auxiliaryData: { keywords: [] } }
        : {
            id: suggestion.id,
            label: suggestion.label,
            auxiliaryData: {
              keywords:
                suggestion.keywords?.filter((value): value is string => Boolean(value)) ?? [],
              description: suggestion.description,
            },
          };
    if (item.id && item.label) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}
