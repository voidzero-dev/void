/** @jsxImportSource react */

import {
  Typeahead,
  TypeaheadItem,
  type SearchSource,
  type SearchableItem,
} from '@astryxdesign/core/Typeahead';
import { useMemo } from 'react';
import { useFateClient } from 'react-fate';
import { UserSuggestionsView, userSuggestionsRequest } from '../../fate/views.ts';

export type AdminUserSuggestion = SearchableItem<{ description: string }>;

const noExcludedUsers: ReadonlySet<string> = new Set();

export function AdminUserTypeahead({
  label,
  selected,
  onChange,
  excludedUserIds = noExcludedUsers,
}: {
  label: string;
  selected: AdminUserSuggestion | null;
  onChange: (user: AdminUserSuggestion | null) => void;
  excludedUserIds?: ReadonlySet<string>;
}) {
  const fate = useFateClient();
  const source = useMemo<SearchSource<AdminUserSuggestion>>(
    () => ({
      bootstrap: () => [],
      search: async (query: string) => {
        const { usersPage: ref } = await fate.request(
          userSuggestionsRequest(`/admin/users?search=${encodeURIComponent(query)}`),
          { mode: 'network-only' },
        );
        if (!ref) {
          return [];
        }
        const { data } = await fate.readView(UserSuggestionsView, ref);
        return data.suggestions
          .filter((user) => !excludedUserIds.has(user.id))
          .map((user) => ({
            id: user.id,
            label: user.label,
            auxiliaryData: { description: user.description },
          }));
      },
    }),
    [fate, excludedUserIds],
  );

  return (
    <Typeahead
      label={label}
      placeholder="Search by login, email, or ID"
      searchSource={source}
      value={selected}
      onChange={onChange}
      onChangeQuery={() => onChange(null)}
      renderItem={(item: AdminUserSuggestion) => (
        <TypeaheadItem item={item} description={item.auxiliaryData?.description} />
      )}
      minQueryLength={2}
      width="min(100%, 320px)"
      emptySearchText="No eligible users found."
    />
  );
}
