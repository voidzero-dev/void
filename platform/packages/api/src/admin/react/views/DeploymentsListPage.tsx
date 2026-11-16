/** @jsxImportSource react */

import { useEffect, useState } from 'react';
import { useRequest, useView } from 'react-fate';
import { DeploymentsPageView, deploymentsPageRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { DeploymentTable } from './DeploymentTable.tsx';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import { SearchForm } from './SearchForm.tsx';
import { SectionStack } from './SectionStack.tsx';

export function DeploymentsListPage({ path, platformName, username }: AdminPageProps) {
  const { deploymentsPage: ref } = useRequest(deploymentsPageRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(DeploymentsPageView, ref);
  if (!pageData) {
    throw new Error('Deployments page data is unavailable.');
  }
  const { deployments, search, page, totalPages, tz } = pageData;
  const [filter, setFilter] = useState(search ?? '');
  useEffect(() => setFilter(search ?? ''), [search]);
  const selectedDeployment = pageData.suggestions.find((item) => item.id === search);
  return (
    <Layout platformName={platformName} title="Deployments" username={username}>
      <SectionStack>
        <h1>Deployments</h1>
        <SearchForm
          action="/admin/deployments"
          kind="deployments"
          label="Search deployments"
          value={filter}
          onChange={setFilter}
          initialValue={search}
          initialSelection={selectedDeployment}
        />
        <DeploymentTable deployments={deployments} showProject tz={tz} />
        {page != null && totalPages != null && (
          <Pagination page={page} totalPages={totalPages} baseUrl="/admin/deployments" />
        )}
      </SectionStack>
    </Layout>
  );
}
