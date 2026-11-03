/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Heading } from '@astryxdesign/core/Text';
import { useNavigation } from '@void/react';
import type { PageObject } from 'void/pages-protocol';
import { AdminUiProviders } from './AdminProviders.tsx';
import { matchAdminRoute, type AdminPageId } from './pages.ts';
import { Layout } from './views/Layout.tsx';
import { SectionStack } from './views/SectionStack.tsx';

const TITLES: Partial<Record<AdminPageId, string>> = {
  platformStatus: 'Platform status',
  dashboard: 'Dashboard',
  plans: 'Plans',
  planEdit: 'Edit plan',
  planPreview: 'Review plan change',
  planProgress: 'Updating accounts',
  users: 'Users',
  userDetail: 'User',
  projects: 'Projects',
  projectDetail: 'Project',
  projectOwnerPreview: 'Transfer owner',
  deployments: 'Deployments',
  deploymentDetail: 'Deployment',
  buildDetail: 'Build',
  cliVersions: 'CLI Versions',
  signupControl: 'Access',
  authSettings: 'Authentication',
  authNew: 'Add login method',
  authEdit: 'Edit login method',
  email: 'Email',
  emailProject: 'Project email',
  emailOperation: 'Email operation',
  invitations: 'Invitations',
  zeroTrust: 'Zero Trust',
};

export function AdminNavigationFallback({ initialPageData }: { initialPageData: PageObject }) {
  const navigation = useNavigation();
  const path =
    navigation.location?.pathname ?? new URL(initialPageData.url, 'https://void.invalid').pathname;
  const title = TITLES[matchAdminRoute(path) ?? 'adminError'] ?? 'Admin';
  const platformName = String(initialPageData.props.platformName ?? 'Void');
  const username =
    typeof initialPageData.props.username === 'string' ? initialPageData.props.username : undefined;

  return (
    <AdminUiProviders>
      <Layout title={title} platformName={platformName} username={username}>
        <SectionStack as="div" className="void-admin-loading" role="status" aria-live="polite">
          <Heading level={1}>{title}</Heading>
          <span className="void-admin-sr-only">Loading {title.toLowerCase()}…</span>
          <SectionStack as="div" className="void-admin-loading-lines" aria-hidden="true">
            <Skeleton width="32%" height={24} />
            <Skeleton width="100%" height={48} index={1} />
            <Skeleton width="100%" height={48} index={2} />
            <Skeleton width="78%" height={48} index={3} />
          </SectionStack>
        </SectionStack>
      </Layout>
    </AdminUiProviders>
  );
}
