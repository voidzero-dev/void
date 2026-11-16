/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Heading } from '@astryxdesign/core/Text';
import { useState } from 'react';
import { useRequest, useView } from 'react-fate';
import type { EmailDomainManagement, EmailRecipientPolicy } from '../../../email/settings.ts';
import { EmailSettingsView, emailSettingsRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { AdminCard } from './AdminCard.tsx';
import { FormTextArea } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';

const EMAIL_SETUP_GUIDE = 'https://void.cloud/guide/platform/installation/credentials#enable-email';

function EmailSettingsHeader() {
  return (
    <SectionStack as="header" className="void-admin-email-intro">
      <Heading level={1}>Email</Heading>
      <p>
        Manage email settings for the platform. Each project’s email page contains its usage,
        limits, and domains.
      </p>
    </SectionStack>
  );
}

export function EmailSettingsPage({
  path,
  platformName,
  username,
  emailEnabled,
}: AdminPageProps & { emailEnabled?: boolean }) {
  if (emailEnabled === false) {
    return (
      <Layout platformName={platformName} title="Email" username={username}>
        <PageStack className="void-admin-email-settings">
          <EmailSettingsHeader />
          <AdminCard title="Enable email">
            <p>Email is not enabled on this platform.</p>
            <p>Set up a shared sender domain and Cloudflare zone, then upgrade the platform.</p>
            <Button
              as="a"
              href={EMAIL_SETUP_GUIDE}
              label="How to enable email"
              variant="secondary"
            />
          </AdminCard>
        </PageStack>
      </Layout>
    );
  }
  return <EnabledEmailSettingsPage path={path} platformName={platformName} username={username} />;
}

function EnabledEmailSettingsPage({ path, platformName, username }: AdminPageProps) {
  const { emailSettings: ref } = useRequest(emailSettingsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(EmailSettingsView, ref);
  if (!pageData) {
    throw new Error('Email settings are unavailable.');
  }
  const { policy, management, senderDomain } = pageData;
  const [mode, setMode] = useState(policy.mode);
  const [domainManagement, setDomainManagement] = useState(management);
  return (
    <Layout platformName={platformName} title="Email" username={username}>
      <PageStack className="void-admin-email-settings">
        <EmailSettingsHeader />
        <AdminCard title="Recipient policy">
          <p>
            Choose which recipients can receive email sent from the shared sender
            {senderDomain ? (
              <>
                {' '}
                (<code>{`<project-name>+tag@${senderDomain}`}</code>)
              </>
            ) : null}
            . This does not affect email sent from custom domains.
          </p>
          <SectionStack
            as="form"
            method="post"
            action="/admin/email/policy"
            className="void-admin-email-choice-form"
          >
            <RadioList
              label="Recipient policy"
              isLabelHidden
              size="sm"
              htmlName="mode"
              value={mode}
              onChange={(value: string) => setMode(value as EmailRecipientPolicy['mode'])}
            >
              <RadioListItem
                value="verified"
                label="verified"
                description="Only each project's verified destinations (default)"
              />
              <RadioListItem
                value="domains"
                label="domains"
                description="Verified destinations, plus any address on these domains. Addresses on the platform's own mail domain stay verified-destination-only."
              />
              <RadioListItem
                value="any"
                label="any"
                description="Every recipient; addresses on the platform's own mail domain stay verified-destination-only, so no project reaches another project's inbox without its consent."
              />
            </RadioList>
            <FormTextArea
              label="Allowed domains"
              name="domains"
              initialValue={policy.domains.join('\n')}
              width={360}
              placeholder="example.com, corp.example.net"
            />
            <Button type="submit" label="Save policy" />
          </SectionStack>
          <p>
            With <code>domains</code> or <code>any</code>, Cloudflare still refuses a destination it
            has not verified unless the platform mail domain is onboarded for Email Sending (Workers
            Paid). Those refusals arrive as per-recipient <code>UNVERIFIED_DESTINATION</code>{' '}
            results.
          </p>
        </AdminCard>
        <AdminCard title="Domain management">
          <p>Who registers custom email domains for projects.</p>
          <SectionStack
            as="form"
            method="post"
            action="/admin/email/settings"
            className="void-admin-email-choice-form"
          >
            <RadioList
              label="Domain management"
              isLabelHidden
              size="sm"
              htmlName="domains"
              value={domainManagement}
              onChange={(value: string) => setDomainManagement(value as EmailDomainManagement)}
            >
              <RadioListItem
                value="self-serve"
                label="self-serve"
                description="Project owners grant a Cloudflare credential from void email domain add."
              />
              <RadioListItem
                value="admin"
                label="admin"
                description="Administrators add domains; void email domain add prints the administrator's command instead."
              />
            </RadioList>
            <Button type="submit" label="Save" />
          </SectionStack>
        </AdminCard>
      </PageStack>
    </Layout>
  );
}
