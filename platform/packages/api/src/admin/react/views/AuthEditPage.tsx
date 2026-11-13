/** @jsxImportSource react */

import { useRequest, useView } from 'react-fate';
import { AuthEditView, authEditRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { ConnectionForm } from './ConnectionForm.tsx';
import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';
export function AuthEditPage({ path, platformName, username }: AdminPageProps) {
  const { authEdit: ref } = useRequest(authEditRequest(path), { mode: 'stale-while-revalidate' });
  const pageData = useView(AuthEditView, ref);
  if (!pageData) {
    throw new Error('Login method is unavailable.');
  }
  const { configuration, revision, callbackUrl, label } = pageData;
  return (
    <Layout platformName={platformName} title="Edit login method" username={username}>
      <SectionStack>
        <h1>Edit {label}</h1>
        <ConnectionForm
          configuration={configuration}
          revision={revision}
          callbackUrl={callbackUrl}
        />
      </SectionStack>
    </Layout>
  );
}
