/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { AdminCard } from './AdminCard.tsx';
import { FormTextInput, FormTextArea, FormCheckbox } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';

export function ConnectedAppsPage({
  platformName,
  username,
  clients,
  credentials,
  error,
}: {
  platformName: string;
  username?: string;
  clients: Array<{
    id: string;
    name: string;
    operator: string;
    enabled: boolean;
    redirect_uris: Array<string>;
    scopes: Array<string>;
  }>;
  credentials?: { clientId: string; clientSecret: string };
  error?: string;
}) {
  return (
    <Layout title="Connected apps" platformName={platformName} username={username}>
      <h1>Connected apps</h1>
      <PageStack maxWidth={800}>
        {error && <p role="alert">{error}</p>}
        {credentials && (
          <AdminCard
            title="App credentials"
            description="Save the client secret on the app’s server. It is shown once."
          >
            <dl>
              <dt>Client ID</dt>
              <dd>
                <code>{credentials.clientId}</code>
              </dd>
              <dt>Client secret</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>
                <code>{credentials.clientSecret}</code>
              </dd>
            </dl>
          </AdminCard>
        )}
        <AdminCard title="Register application">
          <SectionStack as="form" method="post" action="/admin/connected-apps">
            <FormTextInput label="App name" name="name" required maxLength={80} />
            <FormTextInput label="Operator" name="operator" required maxLength={160} />
            <FormTextArea
              label="Redirect URLs"
              name="redirectUris"
              required
              placeholder="https://build.example.com/auth/callback"
            />
            <FormCheckbox
              label="Allow users to approve individual publishes"
              name="publish"
              submitValue="true"
            />
            <FormCheckbox
              label="Allow private previews with isolated resources"
              name="preview"
              submitValue="true"
            />
            <Button type="submit" label="Register" />
          </SectionStack>
        </AdminCard>
        {clients.map((client) => (
          <AdminCard key={client.id} title={client.name} description={client.operator}>
            <p>
              <code>{client.id}</code>
            </p>
            <p>{client.redirect_uris.join(', ')}</p>
            <p>{client.enabled ? 'Enabled' : 'Disabled'}</p>
            {client.enabled && (
              <form method="post" action={`/admin/connected-apps/${client.id}/preview-permission`}>
                <input
                  type="hidden"
                  name="enabled"
                  defaultValue={client.scopes.includes('preview:deploy') ? 'false' : 'true'}
                />
                <Button
                  type="submit"
                  label={
                    client.scopes.includes('preview:deploy')
                      ? 'Disable private previews'
                      : 'Enable private previews'
                  }
                />
              </form>
            )}
            {client.enabled && (
              <form
                method="post"
                action={`/admin/connected-apps/${client.id}/disable`}
                data-confirm="Disable this app and revoke all of its access?"
              >
                <Button type="submit" label="Disable and revoke access" />
              </form>
            )}
          </AdminCard>
        ))}
      </PageStack>
    </Layout>
  );
}
