import { basename } from 'pathslash';
import { runWranglerAuthToken } from './deploy-cloudflare-auth.ts';
import { log } from './deploy-helpers.ts';
import {
  type CloudflareEmailStepInput,
  type CloudflareEmailStepResult,
  type EmailAddressMapInput,
} from './deploy-types.ts';
import {
  applyEmailSetup,
  EMAIL_FROM_VAR,
  emailConfigInputs,
  preflightEmail,
  SEND_EMAIL_BINDING,
  renderEmailChecklist,
  type EmailCloudflareInputs,
  type EmailPreflight,
} from './email-cloudflare.ts';
import { getErrorMessage } from './output.ts';
import { writeProvisionedWranglerConfig, type ProvisionedWranglerPatch } from './wrangler.ts';

/** Whether the root config carries the `send_email` binding Void writes. */
export function hasVoidSendEmailBinding(rootConfig: Record<string, unknown>): boolean {
  return (
    Array.isArray(rootConfig.send_email) &&
    (rootConfig.send_email as Array<{ name?: unknown } | null>).some(
      (binding) => binding?.name === SEND_EMAIL_BINDING,
    )
  );
}

/**
 * Immediately after setup, the local resolver can retain ENODATA while Cloudflare's public DNS
 * already serves the new subdomain MX. When the committed config is exactly setup's plan and
 * every other inbound prerequisite is still ready, DNS is ambiguous: deleting `addresses`
 * destroys the handoff, while deploying it could fail after upload if routing is genuinely off.
 */
function isCommittedSubdomainPlanWaitingForDns(
  pre: EmailPreflight,
  rootConfig: Record<string, unknown>,
): boolean {
  if (
    pre.mode !== 'subdomain' ||
    (pre.domainMx.state !== 'empty' && pre.domainMx.state !== 'unknown') ||
    pre.routing.enabled !== true ||
    pre.subaddressing.state !== 'on' ||
    pre.binding.state !== 'present' ||
    pre.sender.state !== 'ready' ||
    pre.addressesOwnership.state !== 'mine' ||
    pre.addressesStale ||
    pre.rules.state === 'unknown' ||
    pre.rules.foreign.length > 0 ||
    !Array.isArray(rootConfig.addresses) ||
    rootConfig.addresses.length === 0
  ) {
    return false;
  }

  const allBlockers = pre.blockers.filter((blocker) => blocker.scope === 'all');
  if (pre.domainMx.state === 'empty') {
    return allBlockers.length === 0;
  }
  // `preflightEmail` always adds one all-scope blocker for an unknown domain MX. Exactly one
  // therefore means DNS is the only such blocker, without coupling this gate to rendered prose.
  return allBlockers.length === 1;
}

/**
 * The deploy's email step on the developer's own account: read-only preflight, checklist,
 * one confirmation (default Yes), then apply and write the config patch. Branches that cannot
 * finish return `satisfied: false` and leave `--require-email` to decide. A committed subdomain
 * plan whose new MX is still empty or unreadable is preserved and aborts the deploy before
 * build. The session bearer never appears in any output of this step.
 */
export async function runCloudflareEmailStep(
  input: CloudflareEmailStepInput,
): Promise<CloudflareEmailStepResult> {
  const without: CloudflareEmailStepResult = { satisfied: false, configWritten: false, map: null };
  const from = input.voidConfig.email?.from;
  if (!from) {
    const carriesEmailConfig =
      hasVoidSendEmailBinding(input.rootConfig) ||
      (Array.isArray(input.rootConfig.addresses) && input.rootConfig.addresses.length > 0);
    if (carriesEmailConfig) {
      log.info(
        'deploy: email.from is unset; skipping automatic email setup. Existing Cloudflare email configuration is preserved.',
      );
    } else {
      log.warn(
        [
          'deploy: this app uses email, but void.config.ts names no sender.',
          'Set email.from to "you@mail.acme.com" in void.config.ts — automatic email setup skipped.',
        ].join('\n'),
      );
    }
    return without;
  }
  const { rootConfig } = input;
  const configName = basename(input.configPath);
  const inputs: EmailCloudflareInputs = {
    handlers: input.handlers,
    from,
    workerName: input.workerName,
    accountId: input.accountId,
    ...emailConfigInputs(rootConfig),
    configPath: input.configPath,
    apiBaseUrl: input.apiBaseUrl,
    runWrangler: input.runWrangler,
    getSessionBearer: () => runWranglerAuthToken(input.runWrangler, input.configPath),
    fetchImpl: input.fetchImpl,
    dns: input.dns,
  };

  let pre: EmailPreflight;
  try {
    pre = await preflightEmail(inputs);
  } catch (err) {
    log.warn(`deploy: email preflight failed — ${getErrorMessage(err)}. Deploying without email.`);
    return without;
  }
  const mapFor = (
    addresses: Array<string>,
    sendingReady: boolean,
    creating: Array<string> = [],
  ): EmailAddressMapInput => ({
    from,
    routes: pre.derived.routes,
    addresses,
    sendingReady,
    creating,
  });
  // Pin `configPath` so every step writes the same file. A refused write (e.g. a comment
  // nested in `addresses`) is reported as-is; the caller decides what the deploy ships.
  const writeConfig = (patch: ProvisionedWranglerPatch): boolean => {
    try {
      writeProvisionedWranglerConfig(input.root, patch, { configPath: input.configPath });
      return true;
    } catch (err) {
      log.error(`deploy: could not update ${configName} — ${getErrorMessage(err)}.`);
      return false;
    }
  };

  // Ready: no prompt and no account call; a sending onboarding recorded as refused is never
  // retried here. The config rows are still rewritten, because a stale `addresses` entry
  // becomes a plan conflict and a stale `__VOID_EMAIL_FROM` ships the old sender. `null`
  // removes the key when every derived address is routed elsewhere.
  if (pre.ready) {
    const patch: ProvisionedWranglerPatch = {};
    const rows: Array<string> = [];
    if (pre.addressesStale) {
      patch.addresses = pre.addresses.length > 0 ? pre.addresses : null;
      rows.push(
        pre.addresses.length > 0
          ? `addresses: ${JSON.stringify(pre.addresses)}`
          : 'addresses removed',
      );
    }
    if (pre.sender.state !== 'ready') {
      patch.vars = { [EMAIL_FROM_VAR]: from };
      rows.push(`vars.${EMAIL_FROM_VAR}: ${JSON.stringify(from)}`);
    }
    let configWritten = false;
    if (rows.length > 0) {
      // The prune rows the checklist would have carried: say why an entry goes.
      for (const foreign of pre.addressesStale ? pre.rules.foreign : []) {
        log.message(
          `    ! ${foreign.address}: already routed to ${foreign.owner}; left alone, not in addresses`,
        );
      }
      if (!writeConfig(patch)) {
        log.warn(`deploy: deploying with the email setup ${configName} already carries.`);
        return {
          ...without,
          map: mapFor(existingAddresses(rootConfig, pre), pre.sending.state === 'ready'),
        };
      }
      configWritten = true;
      log.message(`  ✔ config    ${configName} updated (${rows.join(', ')})`);
    }
    return {
      satisfied: true,
      configWritten,
      map: mapFor(pre.addresses, pre.sending.state === 'ready', pre.rulesPending),
    };
  }

  // The checklist carries the `✘` rows, so a blocked run explains itself before the warn line.
  log.message(renderEmailChecklist(pre));
  if (isCommittedSubdomainPlanWaitingForDns(pre, rootConfig)) {
    const dnsState =
      pre.domainMx.state === 'empty'
        ? 'this resolver sees no MX records yet'
        : 'the MX lookup failed';
    log.error(
      [
        `deploy: cannot verify Email Routing on ${pre.domain} because ${dnsState}.`,
        `The existing addresses plan in ${configName} is preserved. DNS may still be propagating after \`void email setup\`; run \`void email status --platform cloudflare\` and retry the deploy when this resolver sees Cloudflare's MX records.`,
        'Nothing was built or uploaded.',
      ].join('\n'),
    );
    return {
      ...without,
      abortDeploy: true,
      map: mapFor(existingAddresses(rootConfig, pre), pre.sending.state === 'ready'),
    };
  }
  // The exits below leave the account alone and ship whatever the config carries. Void's own
  // `addresses` array is removed (never `[]`) when routing is off, since its plan would fail
  // (`2062`) after the upload on every deploy.
  const shipsBinding = pre.binding.state === 'present';
  const leaveAccount = (reason: string): CloudflareEmailStepResult => {
    let configWritten = false;
    if (
      Array.isArray(rootConfig.addresses) &&
      pre.addressesOwnership.state === 'mine' &&
      pre.routing.state !== 'ready'
    ) {
      // A refused write leaves the array where it is; the deploy goes on as it would have.
      if (writeConfig({ addresses: null })) {
        configWritten = true;
        log.message(
          `  ! config    addresses removed from ${configName} (routing on ${pre.domain} is ${pre.routing.state}); no routing rule is created for ${(rootConfig.addresses as Array<unknown>).map(String).join(', ')}`,
        );
      }
    }
    log.warn(
      `deploy: ${reason} — ${shipsBinding ? `deploying with the email setup ${configName} already carries.` : 'deploying without email.'}`,
    );
    return {
      satisfied: false,
      configWritten,
      map: shipsBinding
        ? mapFor(
            configWritten ? [] : existingAddresses(rootConfig, pre),
            pre.sending.state === 'ready',
          )
        : null,
    };
  };
  if (pre.blockers.some((b) => b.scope === 'all')) {
    return leaveAccount(`email on ${pre.domain} cannot be set up from here.`);
  }
  if (input.nonInteractive) {
    return leaveAccount(
      [
        `email on ${pre.domain} is not ${shipsBinding ? 'fully ' : ''}set up, and this shell cannot ask.`,
        'Run `void email setup --platform cloudflare` once locally, commit void.lock.json, then redeploy.',
      ].join('\n'),
    );
  }
  if (!(await input.confirm(`Set up email on ${pre.domain}?`))) {
    return leaveAccount(
      'email setup skipped — run `void email setup --platform cloudflare` later.',
    );
  }

  const out = await applyEmailSetup(pre, inputs);
  if (out.lines.length > 0) {
    log.message(out.lines.join('\n'));
  }
  if (!writeConfig(out.patch)) {
    log.warn('deploy: deploying without email.');
    return without;
  }
  const bindingPresent = shipsBinding || out.patch.sendEmail !== undefined;
  const written = out.patch.addresses ?? [];
  // Require the capabilities the app uses; sending-only apps need no inbound setup.
  // The map follows the binding, since the worker ships with email either way.
  return {
    satisfied: out.ready,
    configWritten: true,
    map: bindingPresent
      ? mapFor(
          written,
          out.sendingReady,
          pre.rules.absent.filter((a) => written.includes(a)),
        )
      : null,
  };
}

/** The committed `addresses` entries that are still Void's pruned set (what wrangler keeps). */
function existingAddresses(
  rootConfig: Record<string, unknown>,
  pre: EmailPreflight,
): Array<string> {
  return Array.isArray(rootConfig.addresses)
    ? (rootConfig.addresses as Array<unknown>)
        .map((a) => (typeof a === 'string' ? a.toLowerCase() : ''))
        .filter((a) => pre.addresses.includes(a))
    : [];
}
