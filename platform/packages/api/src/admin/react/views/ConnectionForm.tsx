/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import type { PlatformLoginConfiguration } from '@void/platform';
import { CodeBlock } from './CodeBlock.tsx';
import { FormTextInput } from './FormControls.tsx';
import { SectionStack } from './SectionStack.tsx';
const HOME = '/admin/config/auth';
export function ConnectionForm({
  configuration,
  revision,
  callbackUrl,
}: {
  configuration: Partial<PlatformLoginConfiguration> & {
    id: string;
    kind: PlatformLoginConfiguration['kind'];
  };
  revision: number | null;
  callbackUrl: string;
}) {
  return (
    <SectionStack
      as="form"
      method="post"
      action={`${HOME}/connections/${encodeURIComponent(configuration.id)}/configure`}
      maxWidth={700}
    >
      <input type="hidden" name="id" defaultValue={configuration.id} />
      <input type="hidden" name="kind" defaultValue={configuration.kind} />
      <input type="hidden" name="revision" defaultValue={revision ?? ''} />
      <p>Register this callback URL with the provider:</p>
      <CodeBlock code={callbackUrl} />
      <FormTextInput
        label="Connection ID"
        name="connectionId"
        initialValue={configuration.id}
        isReadOnly={
          revision !== null || configuration.kind === 'github' || configuration.kind === 'google'
        }
        required
      />
      <FormTextInput
        label="Login button label"
        name="label"
        initialValue={configuration.label ?? ''}
        maxLength={100}
        required
      />
      {(configuration.kind === 'oidc' || configuration.kind === 'cloudflare-access') && (
        <FormTextInput
          label="Issuer URL"
          name="issuer"
          type="url"
          initialValue={configuration.issuer ?? ''}
          required
        />
      )}
      <FormTextInput
        label="Client ID"
        name="clientId"
        initialValue={configuration.clientId ?? ''}
        required
      />
      <FormTextInput
        label="Client secret"
        name="clientSecret"
        type="password"
        autoComplete="new-password"
        required={revision === null}
      />
      {revision !== null && <p>Leave the secret blank to retain its saved value.</p>}
      {configuration.kind === 'google' && (
        <FormTextInput
          label="Allowed Workspace domains"
          name="domains"
          initialValue={configuration.allowedDomains?.join(', ') ?? ''}
          placeholder="example.com, example.org"
          description="Leave blank to allow any Google account to authenticate. Signup remains controlled separately."
        />
      )}
      {(configuration.kind === 'oidc' || configuration.kind === 'cloudflare-access') && (
        <FormTextInput
          label="Allowed groups"
          name="groups"
          initialValue={configuration.requiredGroups?.join(', ') ?? ''}
          description="Comma-separated; leave blank to use the provider's access policy."
        />
      )}
      <p>Save a pending configuration, then test it before enabling it.</p>
      <Button type="submit" label="Save configuration" />
    </SectionStack>
  );
}
