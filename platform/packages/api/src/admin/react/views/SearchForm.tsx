/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { useRouter } from '@void/react';
import { useCallback } from 'react';
import { useFateClient } from 'react-fate';
import {
  DeploymentSuggestionsView,
  deploymentSuggestionsRequest,
  ProjectSuggestionsView,
  projectSuggestionsRequest,
  UserSuggestionsView,
  userSuggestionsRequest,
} from '../../fate/views.ts';
import { SearchTypeahead, type SearchSuggestion } from './SearchTypeahead.tsx';

export function SearchForm({
  action,
  kind,
  label,
  value,
  onChange,
  initialValue,
  initialSelection,
}: {
  action: string;
  kind: 'users' | 'projects' | 'deployments';
  label: string;
  value: string;
  onChange: (value: string) => void;
  initialValue?: string;
  initialSelection?: SearchSuggestion;
}) {
  const fate = useFateClient();
  const router = useRouter();
  const remoteSearch = useCallback(
    async (query: string): Promise<ReadonlyArray<SearchSuggestion>> => {
      const path = `${action}?search=${encodeURIComponent(query)}`;
      if (kind === 'users') {
        const { usersPage: ref } = await fate.request(userSuggestionsRequest(path), {
          mode: 'network-only',
        });
        if (!ref) {
          return [];
        }
        const { data } = await fate.readView(UserSuggestionsView, ref);
        return data.suggestions;
      }
      if (kind === 'projects') {
        const { projectsPage: ref } = await fate.request(projectSuggestionsRequest(path), {
          mode: 'network-only',
        });
        if (!ref) {
          return [];
        }
        const { data } = await fate.readView(ProjectSuggestionsView, ref);
        return data.suggestions;
      }
      const { deploymentsPage: ref } = await fate.request(deploymentSuggestionsRequest(path), {
        mode: 'network-only',
      });
      if (!ref) {
        return [];
      }
      const { data } = await fate.readView(DeploymentSuggestionsView, ref);
      return data.suggestions;
    },
    [action, fate, kind],
  );

  return (
    <form method="get" action={action} className="void-admin-search">
      <input type="hidden" name="search" value={value} />
      <SearchTypeahead
        key={initialValue ?? ''}
        label={label}
        onChange={onChange}
        onSelect={(id) => void router.visit(`${action}/${encodeURIComponent(id)}`)}
        onClear={() => {
          if (initialValue) {
            void router.visit(action);
          }
        }}
        remoteSearch={remoteSearch}
        initialValue={initialValue}
        initialSelection={initialSelection}
      />
      <Button type="submit" label="Search" />
    </form>
  );
}
