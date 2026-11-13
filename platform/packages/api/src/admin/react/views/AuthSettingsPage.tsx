/** @jsxImportSource react */

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Text';
import type { PlatformLoginConfiguration } from '@void/platform';
import { useRequest, useView } from 'react-fate';
import { AuthSettingsView, authSettingsRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { AdminCard } from './AdminCard.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';

const HOME = '/admin/config/auth';
const LOGIN_KINDS = [
  { kind: 'github', label: 'GitHub' },
  { kind: 'google', label: 'Google' },
  { kind: 'oidc', label: 'Generic OIDC' },
  { kind: 'cloudflare-access', label: 'Cloudflare Access' },
] as const satisfies ReadonlyArray<{ kind: PlatformLoginConfiguration['kind']; label: string }>;

export function AuthSettingsPage({ path, platformName, username }: AdminPageProps) {
  const { authSettings: ref } = useRequest(authSettingsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(AuthSettingsView, ref);
  if (!pageData) {
    throw new Error('Authentication settings are unavailable.');
  }
  const { data, tested } = pageData;
  return (
    <Layout platformName={platformName} title="Authentication settings" username={username}>
      <PageStack className="void-admin-auth-settings">
        <SectionStack as="header" className="void-admin-auth-intro">
          <Heading level={1}>Authentication</Heading>
          <p>Manage how people reach the platform and sign in.</p>
        </SectionStack>

        <section aria-labelledby="platform-protection-heading">
          <AdminCard
            title="Platform protection"
            titleId="platform-protection-heading"
            description="Control access to the platform before visitors reach a login page."
            headerAccessory={
              <Badge
                label={
                  data.protection ? 'Cloudflare Access enabled' : 'Cloudflare Access not enabled'
                }
                variant={data.protection ? 'success' : 'neutral'}
              />
            }
          >
            <SectionStack as="div" className="void-admin-auth-protection-details">
              <div className="void-admin-auth-protection-steps">
                <AdminCard title="Enable Cloudflare Access" headingLevel={3}>
                  <p>
                    Create or connect an Access application and verify every platform origin. The
                    installing CLI needs the installation's recovery credentials and Access setup
                    permission.
                  </p>
                  <CodeBlock
                    code="void platform config auth protection enable --installation <id>"
                    language="shellscript"
                  />
                </AdminCard>
                <AdminCard title="Disable Cloudflare Access" headingLevel={3}>
                  <p>First change any signup policy that relies on Access.</p>
                  <CodeBlock
                    code="void platform config auth protection disable --installation <id>"
                    language="shellscript"
                  />
                </AdminCard>
              </div>
              <p>
                Enabling or disabling platform protection signs out users and administrators.
                They’ll need to sign in again.
              </p>
              <p>
                Disabling protection leaves the Cloudflare Access applications in place. Delete them
                in Cloudflare when you no longer need them.
              </p>
              <p>Login methods and protection for individual apps are configured separately.</p>
            </SectionStack>
          </AdminCard>
        </section>

        {!data.initialized ? (
          <AdminCard title="Set up authentication settings">
            <p>
              Initialize settings to manage your existing login methods here. Their configuration is
              preserved; you will sign in again.
            </p>
            <form method="post" action={`${HOME}/initialize`}>
              <Button type="submit" label="Initialize settings" />
            </form>
          </AdminCard>
        ) : (
          <>
            {tested && (
              <section aria-labelledby="verified-login-heading">
                <AdminCard
                  title="Login verified"
                  titleId="verified-login-heading"
                  description="Review this identity before linking or enabling the tested method."
                  headerAccessory={<Badge label="Ready to review" variant="success" />}
                >
                  <dl className="void-admin-auth-identity">
                    <div>
                      <dt>Account</dt>
                      <dd>{tested.login || tested.subject}</dd>
                    </div>
                    <div>
                      <dt>Provider</dt>
                      <dd>{tested.issuer}</dd>
                    </div>
                    <div>
                      <dt>Identity</dt>
                      <dd>{tested.subject}</dd>
                    </div>
                  </dl>
                  <div className="void-admin-auth-actions">
                    {(['link', 'enable'] as const).map((action) => (
                      <form
                        key={action}
                        method="post"
                        action={`${HOME}/connections/${encodeURIComponent(tested.connection_id)}/${action}`}
                      >
                        <input type="hidden" name="revision" defaultValue={tested.revision} />
                        <input type="hidden" name="testId" defaultValue={tested.id} />
                        <Button
                          type="submit"
                          label={
                            action === 'link' ? 'Link to my account' : 'Enable tested configuration'
                          }
                          variant={action === 'link' ? 'secondary' : 'primary'}
                        />
                      </form>
                    ))}
                  </div>
                </AdminCard>
              </section>
            )}

            <section aria-labelledby="login-methods-heading">
              <AdminCard
                title="Login methods"
                titleId="login-methods-heading"
                description="Choose the identity providers people can use to sign in."
                headerAccessory={
                  <Badge
                    label={`${data.methods.filter((method) => method.enabled).length} active`}
                    variant="neutral"
                  />
                }
              >
                {data.methods.length ? (
                  <div className="void-admin-auth-method-list">
                    {data.methods.map((method) => (
                      <div className="void-admin-auth-method" key={method.id}>
                        <div className="void-admin-auth-method-info">
                          <div className="void-admin-auth-method-title">
                            <strong>{method.label}</strong>
                            <Badge
                              label={method.enabled ? 'Enabled' : 'Disabled'}
                              variant={method.enabled ? 'success' : 'neutral'}
                            />
                            {'activeRevision' in method &&
                              method.activeRevision !== method.revision && (
                                <Badge label="Pending configuration" variant="warning" />
                              )}
                          </div>
                          <span className="void-admin-auth-method-type">
                            {LOGIN_KINDS.find(({ kind }) => kind === method.kind)?.label ??
                              method.kind}
                          </span>
                        </div>
                        <div className="void-admin-auth-actions">
                          <Button
                            href={`${HOME}/connections/${encodeURIComponent(method.id)}`}
                            label="Edit"
                            variant="secondary"
                            size="sm"
                          />
                          <form
                            method="post"
                            action={`${HOME}/connections/${encodeURIComponent(method.id)}/test`}
                          >
                            <Button
                              type="submit"
                              label="Test login"
                              variant="secondary"
                              size="sm"
                            />
                          </form>
                          {method.enabled && 'revision' in method && (
                            <form
                              method="post"
                              action={`${HOME}/connections/${encodeURIComponent(method.id)}/disable`}
                            >
                              <input type="hidden" name="revision" defaultValue={method.revision} />
                              <Button
                                type="submit"
                                label="Disable and revoke sessions"
                                variant="destructive"
                                size="sm"
                              />
                            </form>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="void-admin-auth-empty">No login methods configured yet.</p>
                )}
                <SectionStack as="div" className="void-admin-auth-add-methods">
                  <h3>Add a login method</h3>
                  <div className="void-admin-auth-actions">
                    {LOGIN_KINDS.map(({ kind, label }) => (
                      <Button
                        key={kind}
                        href={`${HOME}/new?kind=${kind}`}
                        label={label}
                        variant="secondary"
                        size="sm"
                      />
                    ))}
                  </div>
                </SectionStack>
              </AdminCard>
            </section>
          </>
        )}
        <section aria-labelledby="account-access-heading">
          <AdminCard
            title="Who can join?"
            titleId="account-access-heading"
            description="Set the signup policy, invite people, and manage individual grants on Access."
          >
            <Button href="/admin/signup-control" label="Manage access" variant="secondary" />
          </AdminCard>
        </section>
      </PageStack>
    </Layout>
  );
}
