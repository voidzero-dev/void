import { defineHandler, defineHead } from 'void';
import { apiClient, getApiErrorMessage, readApiJson } from '../../lib/api.ts';
import type { ProjectListItem } from '../../lib/api.ts';

export type ProjectRow = Readonly<{
  slug: string;
  role: ProjectListItem['role'];
}>;

export type Props = Readonly<{
  projects: ReadonlyArray<ProjectRow>;
  error?: string;
}>;

export const head = defineHead<Props>(() => ({ title: 'Projects' }));

/** The projects the signed-in user is a member of, with a link to each security page. */
export const loader = defineHandler<Props>(async (context) => {
  try {
    const response = await apiClient(context).projects.$get();
    if (!response.ok) {
      return { projects: [], error: await getApiErrorMessage(response) };
    }
    const projects = (await readApiJson<ReadonlyArray<ProjectListItem>>(response)) ?? [];
    return {
      projects: projects.map((project) => ({
        slug: project.slug,
        role: project.role,
      })),
    };
  } catch {
    return { projects: [], error: 'The service is temporarily unavailable. Try again shortly.' };
  }
});
