/** @jsxImportSource react */

import { useRequest, useView } from 'react-fate';
import { AuthNewView, authNewRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { ConnectionForm } from './ConnectionForm.tsx';
import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';
export function AuthNewPage({ path, platformName, username }: AdminPageProps) {
  const { authNew: ref } = useRequest(authNewRequest(path), { mode: 'stale-while-revalidate' });
  const pageData = useView(AuthNewView, ref);
  if (!pageData) {
    throw new Error('Login method is unavailable.');
  }
  const { kind, connectionId: id, callbackUrl } = pageData;
  return (
    <Layout platformName={platformName} title="Add login method" username={username}>
      <SectionStack>
        <h1>Add login method</h1>
        <ConnectionForm
          configuration={{
            id,
            kind,
            label:
              kind === 'oidc'
                ? 'Company SSO'
                : kind === 'cloudflare-access'
                  ? 'Cloudflare Access'
                  : kind === 'github'
                    ? 'GitHub'
                    : 'Google',
          }}
          revision={null}
          callbackUrl={callbackUrl}
        />
      </SectionStack>
    </Layout>
  );
}
