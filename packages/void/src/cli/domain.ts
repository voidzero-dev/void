import { log } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import type { DomainStatusResponse } from './client.ts';
import type { DomainArgs } from './domain-args.ts';
import { printSuccess, note, pc } from './output.ts';
import { readDeploymentPlatform } from './project.ts';
import { resolveCommandProjectId } from './resolve-project.ts';

export async function runDomainCommand(root: string, args: DomainArgs): Promise<void> {
  const platform = readDeploymentPlatform(root);
  if (platform === 'cloudflare') {
    return runCloudflareDomainCommand(root, args);
  }
  if (platform === 'none') {
    throw new Error('domain: Deployment is disabled. Run `void init` to choose a platform.');
  }

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  const projectId = await resolveCommandProjectId(client, root, args.projectSlug);

  switch (args.subcommand) {
    case 'add':
      return domainAdd(client, projectId, args.hostname!);
    case 'delete':
      return domainRemove(client, projectId, args.hostname!);
    case 'list':
      return domainList(client, projectId);
    case 'status':
      return domainStatus(client, projectId, args.hostname!, args.verbose === true);
  }
}

async function runCloudflareDomainCommand(root: string, args: DomainArgs): Promise<void> {
  if (args.projectSlug) {
    throw new Error(
      'domain: --project selects a Void platform project and is not used for direct Cloudflare apps.',
    );
  }
  const { changeCloudflareDomain, listCloudflareDomains } =
    await import('./cloudflare-operations.ts');

  if (args.subcommand === 'add') {
    const result = await changeCloudflareDomain(root, args.hostname!, 'add');
    note(
      'Cloudflare Custom Domains manages the DNS record and TLS certificate in the zone on your account.',
      'Cloudflare Domain',
    );
    if (result.modified) {
      printSuccess(`Domain ${args.hostname} added and activated on Cloudflare.`);
    } else {
      log.info(`Domain ${args.hostname} is already configured.`);
    }
    return;
  }
  if (args.subcommand === 'delete') {
    const result = await changeCloudflareDomain(root, args.hostname!, 'delete');
    if (result.modified) {
      printSuccess(`Domain ${args.hostname} removed from Cloudflare.`);
    } else {
      log.info(`Domain ${args.hostname} is not configured.`);
    }
    return;
  }

  const domains = listCloudflareDomains(root);
  if (args.subcommand === 'list') {
    if (domains.length === 0) {
      log.info('No custom domains configured.');
      return;
    }
    note(
      domains.map((domain) => `  ${domain.pattern}  ${pc.green('configured')}`).join('\n'),
      'Custom Domains',
    );
    return;
  }

  const domain = domains.find((entry) => entry.pattern === args.hostname);
  if (!domain) {
    log.error(`domain: Domain '${args.hostname}' is not configured for this Worker.`);
    process.exit(1);
  }
  const lines = [
    `Hostname: ${domain.pattern}`,
    'Status:   configured locally — present in Void Cloudflare config; remote certificate state is managed by Cloudflare.',
  ];
  if (args.verbose) {
    lines.push('', 'Details:', '  Type:        Cloudflare Custom Domain', '  TLS:         managed');
  }
  note(lines.join('\n'), 'Domain Status');
}

async function domainAdd(
  client: PlatformClient,
  projectId: string,
  hostname: string,
): Promise<void> {
  const domain = await client.addDomain(projectId, hostname);

  // Cert DCV uses HTTP-DCV, so no user-facing SSL-validation records exist.
  const recordSections = [
    domain.cname_target ? cnameRecord(hostname, domain.cname_target) : undefined,
    domain.ownership_verification ? ownershipRecord(domain.ownership_verification) : undefined,
  ].filter((s) => s !== undefined);

  if (recordSections.length > 0) {
    const recordWord = recordSections.length === 1 ? 'the record above' : 'the records above';
    const summary = `Add ${recordWord} to your DNS, then run \`void domain status ${hostname}\` to check progress.`;
    note([...recordSections, summary].join('\n\n'), 'DNS Setup');
  }
  printSuccess(`Domain ${hostname} added (status: ${domain.status}).`);
}

async function domainRemove(
  client: PlatformClient,
  projectId: string,
  hostname: string,
): Promise<void> {
  const domain = await findProjectDomain(client, projectId, hostname);
  await client.removeDomain(projectId, domain.id);
  printSuccess(`Domain ${hostname} removed.`);
}

async function domainList(client: PlatformClient, projectId: string): Promise<void> {
  const domains = await client.listDomains(projectId);
  if (domains.length === 0) {
    log.info('No custom domains configured.');
    return;
  }

  const lines = domains.map((d) => {
    const status = d.status === 'active' ? pc.green('active') : pc.yellow(d.status);
    return `  ${d.hostname}  ${status}`;
  });
  note(lines.join('\n'), 'Custom Domains');
}

export type RolledUpStatus = {
  state:
    | 'error'
    | 'awaiting_deployment'
    | 'awaiting_dns'
    | 'verifying_dns'
    | 'issuing_cert'
    | 'deploying_cert'
    | 'active'
    | 'pending';
  diagnostic: string;
};

export function computeRollup(status: DomainStatusResponse): RolledUpStatus {
  // Priority order matters: `error` and `awaiting_deployment` describe
  // user-actionable conditions that should override CF's state-machine view.
  if (status.verification_errors && status.verification_errors.length > 0) {
    return {
      state: 'error',
      diagnostic: `Verification failed: ${status.verification_errors[0]}`,
    };
  }

  if (status.awaiting_deployment === true) {
    return {
      state: 'awaiting_deployment',
      diagnostic:
        'Your project has no live deployment yet. Run `void deploy` to bring the domain online.',
    };
  }

  if (status.cf_status === 'pending' && status.ownership_verification) {
    return {
      state: 'awaiting_dns',
      diagnostic:
        'Cloudflare has not yet observed your _cf-custom-hostname TXT record. Confirm it is published at the host shown below.',
    };
  }

  if (status.cf_status === 'pending_validation') {
    return {
      state: 'verifying_dns',
      diagnostic: 'DNS records found, Cloudflare is validating ownership.',
    };
  }

  if (
    status.cf_status === 'pending_issuance' ||
    (status.cf_status === 'active' && status.ssl_status !== 'active')
  ) {
    return {
      state: 'issuing_cert',
      // ssl_status !== 'active' always holds here, so the CNAME block renders below.
      diagnostic:
        'Cloudflare is issuing the SSL certificate automatically (typically <5 minutes). If this persists, confirm the traffic CNAME below is published.',
    };
  }

  if (status.cf_status === 'pending_deployment') {
    return {
      state: 'deploying_cert',
      diagnostic: 'SSL certificate issued; Cloudflare is propagating it to its edge.',
    };
  }

  // `active` is keyed off the DB status, but only reached after the per-field
  // signals above have already surfaced cert-renewal / re-validation windows
  // (e.g. `issuing_cert` catches `cf_status === 'active' && ssl_status !== 'active'`
  // even when the DB row says active). Reaching this branch means CF and SSL
  // are both healthy.
  if (status.status === 'active' && status.ssl_status === 'active') {
    return { state: 'active', diagnostic: 'Live.' };
  }

  return { state: 'pending', diagnostic: 'Verification pending. Cloudflare is processing.' };
}

async function domainStatus(
  client: PlatformClient,
  projectId: string,
  hostname: string,
  verbose: boolean,
): Promise<void> {
  const domain = await findProjectDomain(client, projectId, hostname);
  const status = await client.getDomainStatus(projectId, domain.id);
  const rollup = computeRollup(status);

  const rollupLines = [
    `Hostname: ${status.hostname}`,
    `Status:   ${rollup.state} — ${rollup.diagnostic}`,
  ];

  if (verbose) {
    // `Hostname:` is already shown by the rollup above.
    rollupLines.push(
      '',
      'Details:',
      `  Status:      ${status.status}`,
      `  SSL Status:  ${status.ssl_status}`,
    );
    if (status.ownership_verification) {
      rollupLines.push(`  Ownership:   pending`);
    }
    if (status.verification_errors && status.verification_errors.length > 0) {
      rollupLines.push(`  Errors:      ${status.verification_errors.join(', ')}`);
    }
  }

  note(rollupLines.join('\n'), 'Domain Status');

  // Surface the DNS records the user may still need to publish. The ownership
  // TXT shows while `ownership_verification` is present (CF drops it once
  // verified). The traffic CNAME shows whenever the cert is not yet active —
  // HTTP-DCV cannot validate until the hostname proxies through Cloudflare, so
  // a missing/misconfigured CNAME silently blocks issuance even after ownership
  // is verified. Once `ssl_status === 'active'` the domain is live and both
  // records are correct, so neither is shown.
  const pendingRecords = [
    status.ssl_status !== 'active' ? cnameRecord(status.hostname, status.cname_target) : undefined,
    status.ownership_verification ? ownershipRecord(status.ownership_verification) : undefined,
  ].filter((s) => s !== undefined);
  if (pendingRecords.length > 0) {
    note(
      pendingRecords.join('\n\n'),
      pendingRecords.length === 1
        ? 'Add this DNS record to your provider'
        : 'Add these DNS records to your provider',
    );
  }
}

async function findProjectDomain(client: PlatformClient, projectId: string, hostname: string) {
  const domains = await client.listDomains(projectId);
  const domain = domains.find((d) => d.hostname === hostname);
  if (!domain) {
    log.error(`domain: Domain '${hostname}' not found on this project.`);
    process.exit(1);
  }
  return domain;
}

function cnameRecord(hostname: string, target: string): string {
  return `CNAME (traffic)\n    ${hostname} → ${target}`;
}

function ownershipRecord(record: { name: string; value: string }): string {
  return `TXT (ownership verification)\n    ${record.name} → ${record.value}`;
}
