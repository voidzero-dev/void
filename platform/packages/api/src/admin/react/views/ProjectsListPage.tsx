/** @jsxImportSource react */

import { useEffect, useState } from 'react';
import { useRequest, useView } from 'react-fate';
import { ProjectsPageView, projectsPageRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import { ProjectsTable } from './ProjectsTable.tsx';
import { SearchForm } from './SearchForm.tsx';
import { SectionStack } from './SectionStack.tsx';

export function ProjectsListPage({ path, platformName, username }: AdminPageProps) {
  const { projectsPage: ref } = useRequest(projectsPageRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(ProjectsPageView, ref);
  if (!pageData) {
    throw new Error('Projects page data is unavailable.');
  }
  const { projects, search, page, totalPages, siteDomain, tz } = pageData;
  const [filter, setFilter] = useState(search ?? '');
  useEffect(() => setFilter(search ?? ''), [search]);
  const selectedProject = pageData.suggestions.find((item) => item.id === search);
  return (
    <Layout platformName={platformName} title="Projects" username={username}>
      <SectionStack>
        <h1>Projects</h1>
        <SearchForm
          action="/admin/projects"
          kind="projects"
          label="Search projects"
          value={filter}
          onChange={setFilter}
          initialValue={search}
          initialSelection={selectedProject}
        />
        <ProjectsTable projects={projects} siteDomain={siteDomain} tz={tz} />
        {page != null && totalPages != null && (
          <Pagination page={page} totalPages={totalPages} baseUrl="/admin/projects" />
        )}
      </SectionStack>
    </Layout>
  );
}
