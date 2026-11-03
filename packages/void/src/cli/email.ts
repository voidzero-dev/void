import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parseRootWranglerConfig, readWranglerTopLevelString } from '@void/deploy-cloudflare';
import { confirm, isCancel, log, password } from '@voidzero-dev/vite-plus-prompts';
import { join } from 'pathslash';
import { readConfig } from '../config.ts';
import { readProjectPaths } from '../project-paths.ts';
import { scanEmailHandlersSync } from '../router/email.ts';
import { getToken, openBrowser } from './auth.ts';
import {
  PlatformApiError,
  PlatformClient,
  type EmailDomainResponse,
  type EmailOperationResponse,
  type EmailSharedInbound,
} from './client.ts';
import {
  createDeployWranglerRunner,
  deriveWorkerName,
  discoverRootWranglerConfig,
  isWranglerNonInteractiveOrCI,
  resolveDeployTransport,
  runWranglerAuthToken,
} from './deploy.ts';
import type { EmailArgs } from './email-args.ts';
import {
  applyEmailSetup,
  createNodeEmailDns,
  emailConfigInputs,
  preflightEmail,
  probeMx,
  renderAddressMap,
  renderEmailChecklist,
  type EmailCloudflareInputs,
  type EmailDns,
  type EmailFetch,
  type EmailPreflight,
  type EmailWranglerRun,
} from './email-cloudflare.ts';
import { printSuccess, createSpinner, formatUrl, note, pc } from './output.ts';
import { resolveCommandProjectId } from './resolve-project.ts';
import { writeProvisionedWranglerConfig } from './wrangler.ts';

export async function runEmailCommand(root: string, args: EmailArgs): Promise<void> {
  // The developer's own Cloudflare account needs no Void token or project.
  if (args.platform === 'cloudflare') {
    return runEmailCloudflareCommand(root, args);
  }
  if (args.subcommand === 'setup') {
    log.error(
      'email: `void email setup` sets email up on your OWN Cloudflare account — run it with `--platform cloudflare`. The Void platform needs no setup: deploy, and `void email alias` shows your address.',
    );
    process.exit(1);
  }
  if (args.subcommand === 'status') {
    log.error(
      'email: `void email status` checks email on your own Cloudflare account. Run it with `--platform cloudflare`. On the Void platform, use `void email usage` and `void email destinations`.',
    );
    process.exit(1);
  }

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  const projectId = await resolveCommandProjectId(client, root, args.projectSlug);

  switch (args.subcommand) {
    case 'usage':
      return emailUsage(client, projectId);
    case 'logs':
      return emailLogs(client, projectId, args.limit);
    case 'destinations':
      return emailDestinations(client, projectId);
    case 'allow':
      return emailAllow(client, projectId, args.address!);
    case 'disallow':
      return emailDisallow(client, projectId, args.address!);
    case 'alias':
      return emailAlias(client, projectId, args.address, { yes: args.yes === true });
    case 'domain':
      return runEmailDomainCommand(client, projectId, args);
  }
}

async function emailUsage(client: PlatformClient, projectId: string): Promise<void> {
  const usage = await client.getEmailUsage(projectId);
  const status = usage.suspended ? pc.red('SUSPENDED') : pc.green('active');
  const lines = [
    `Month:              ${usage.month}`,
    `Status:             ${status}`,
    `Recipient attempts: ${usage.attempts} / ${usage.limit} (${usage.remaining} remaining)`,
    `Inbound receipts:   ${usage.received}`,
  ];
  note(lines.join('\n'), 'Email Usage');
}

export async function emailAlias(
  client: Pick<PlatformClient, 'getEmailSettings' | 'setEmailAlias'>,
  projectId: string,
  name: string | undefined,
  opts: { yes: boolean; isInteractive?: boolean } = { yes: false },
): Promise<void> {
  if (!name) {
    const settings = await client.getEmailSettings(projectId);
    const shared = settings.sharedInbound;
    const domain =
      settings.sharedDomain ??
      (shared ? shared.recipient.slice(shared.recipient.lastIndexOf('@') + 1) : null);
    const name = settings.emailAlias ?? settings.domains.projectSlug;
    if (!domain || !name) {
      log.info('This platform has no shared mail domain.');
      return;
    }
    const address = `${name}@${domain}`;
    const lines = [`Address:  ${address}`, `Inbound:  ${inboundLine(shared, address)}`];
    if (settings.emailAlias && settings.domains.projectSlug) {
      lines.push(`Also:     ${settings.domains.projectSlug}@${domain} (the project slug)`);
    }
    note(lines.join('\n'), 'Shared mail address');
    if (!settings.emailAlias) {
      log.info('Run `void email alias <name>` to give this address a shorter, permanent name.');
    }
    return;
  }
  if (!opts.yes) {
    if (!(opts.isInteractive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
      log.error('email: the alias is permanent. Pass --yes to set it without a prompt.');
      process.exit(1);
    }
    const ok = await confirm({
      message: `Set the permanent email alias "${name}"? It cannot be changed or removed later; the slug address keeps working.`,
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      log.info('Cancelled. No alias was set.');
      return;
    }
  }
  const result = await client.setEmailAlias(projectId, name);
  printSuccess(`Email alias set: ${result.address}`);
  const status = result.sharedInbound?.status;
  if (status && status !== 'ready') {
    const other =
      result.sharedInbound!.recipient === result.address
        ? ''
        : ` at ${result.sharedInbound!.recipient}`;
    log.info(
      `Inbound mail${other} is ${status}${result.sharedInbound?.reason ? `: ${result.sharedInbound.reason}` : ''}. It starts working once the project has an email handler deployed and routing is ready; check with \`void email alias\`.`,
    );
  }
}

/**
 * The inbound status covers every name of the project, so name the address
 * it belongs to when that is not the one shown (the slug row can be the one
 * not ready yet).
 */
function inboundLine(shared: EmailSharedInbound | null | undefined, address: string): string {
  if (!shared) {
    return 'not set up on this platform';
  }
  return shared.recipient === address ? shared.status : `${shared.status} (${shared.recipient})`;
}

async function emailDestinations(client: PlatformClient, projectId: string): Promise<void> {
  const rows = await client.listEmailDestinations(projectId);
  if (rows.length === 0) {
    log.info(
      'No verified destinations. Run `void email allow <address>` to add one — Cloudflare will email the recipient with a verification link.',
    );
    return;
  }
  const lines = rows.map((d) => {
    const status =
      d.status === 'verified'
        ? pc.green('verified')
        : d.status === 'pending'
          ? pc.yellow('pending')
          : pc.red('failed');
    return `  ${d.address.padEnd(40)} ${status}`;
  });
  note(lines.join('\n'), 'Email Destinations');
}

export async function emailAllow(
  client: Pick<PlatformClient, 'addEmailDestination'>,
  projectId: string,
  address: string,
): Promise<void> {
  const dest = await client.addEmailDestination(projectId, address);
  // Cloudflare mails its link on create only; the platform re-sends its own
  // on every repeat add (`platformVerificationPending`). A 201 alone does not
  // prove a send: the api adopts an address Cloudflare already held.
  const sent =
    dest.verificationSent !== false && (dest.created || dest.platformVerificationPending);
  if (dest.status === 'verified') {
    log.info(`${dest.address} is already verified.`);
  } else if (sent) {
    log.info(
      'They click the link in their inbox — no Void or Cloudflare account needed. `void email destinations` to poll status.',
    );
    printSuccess(`Verification email sent to ${dest.address}.`);
  } else if (dest.created) {
    log.warn(
      `${dest.address} is on this project's list now, but Cloudflare already had the address pending (added by another project, or by hand), so no new verification email was sent — the link it mailed when the address was first added is the one to click. ${freshLinkHint(dest.address)}`,
    );
  } else {
    log.info(
      `${dest.address} is still pending — Cloudflare emailed them a verification link when the address was first added, and a repeat add sends nothing new. ${freshLinkHint(dest.address)}`,
    );
  }
}

/**
 * Cloudflare has no API to resend its verification mail; the only fresh link
 * is a fresh registration, and the platform deletes the Cloudflare-side
 * address only once no project still lists it.
 */
function freshLinkHint(address: string): string {
  return `For a fresh link, remove the address from every project that lists it (\`void email disallow ${address}\`), then \`void email allow ${address}\` — Cloudflare mails a new link only when it registers the address anew.`;
}

export async function emailDisallow(
  client: Pick<PlatformClient, 'listEmailDestinations' | 'removeEmailDestination'>,
  projectId: string,
  address: string,
): Promise<void> {
  const rows = await client.listEmailDestinations(projectId);
  const dest = rows.find((d) => d.address.toLowerCase() === address.toLowerCase());
  if (!dest) {
    log.error(`destination: '${address}' is not in the project's allowlist.`);
    process.exit(1);
  }
  await client.removeEmailDestination(projectId, dest.id);
  printSuccess(
    `Removed ${dest.address}. New sends to it are refused immediately; already admitted attempts may finish.`,
  );
}

export async function emailLogs(
  client: Pick<PlatformClient, 'getEmailLogs'>,
  projectId: string,
  limit?: number,
): Promise<void> {
  const result = await client.getEmailLogs(projectId, limit);
  if (result.logs.length === 0) {
    log.info('No email activity recorded.');
    return;
  }
  const lines = result.logs.map((entry) => {
    const ts = new Date(entry.timestamp).toISOString();
    const dir = entry.direction === 'sent' ? '→' : '←';
    return `${ts}  ${dir}  ${entry.operationId}  ${entry.recipient ?? '—'}  ${entry.status}${entry.errorCode ? ` (${entry.errorCode})` : ''}`;
  });
  note(lines.join('\n'), 'Email Logs');
}

// ── Custom domains on the customer's own Cloudflare zone ──────────────────────
//
// The API token is held in memory, sent once, and never printed, logged, or stored locally.

/**
 * Permission groups prefilled in the dashboard token link. `zone_settings: edit` gates
 * the routing POST; `zone: read` serves the zone lookup.
 */
const CF_TOKEN_TEMPLATE_PERMISSION_GROUPS = [
  { key: 'zone', type: 'read' },
  { key: 'email_routing_rule', type: 'edit' },
  { key: 'email_sending', type: 'edit' },
  { key: 'workers_scripts', type: 'edit' },
  { key: 'zone_settings', type: 'edit' },
] as const;

/** Dashboard link that prefills the scoped API token form. */
export function buildCfApiTokenTemplateUrl(domain: string): string {
  const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
  url.searchParams.set('permissionGroupKeys', JSON.stringify(CF_TOKEN_TEMPLATE_PERMISSION_GROUPS));
  // Both are required by the form; the customer narrows them in the summary.
  url.searchParams.set('accountId', '*');
  url.searchParams.set('zoneId', 'all');
  url.searchParams.set('name', `Void email — ${domain}`);
  return url.href;
}

/** 'refused' and 'unknown' are both rejected; 'refused' names a known foreign prefix in the error. */
export type CfApiTokenShape = 'cfut' | 'legacy' | 'refused' | 'unknown';

// `cfut_`, 40 characters, then a CRC32 checksum whose rendered length is not documented,
// so the tail is loose. `GET /user/tokens/verify` is the real gate, not this regex.
const CFUT_TOKEN_PATTERN = /^cfut_[A-Za-z0-9_-]{44,64}$/;
// Pre-2026 tokens: an unprefixed 40-character string. Still accepted by CF.
const LEGACY_CF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40}$/;
// Another service's token is named without a network call instead of surfacing as a CF 401.
// `cfk_` is Cloudflare's global key, not a scoped token.
const REFUSED_TOKEN_PREFIXES = ['ghp_', 'github_pat_', 'sk-', 'xox', 'cfk_'] as const;

/** Shape-only classification of a clipboard or pasted value. Never logs the value. */
export function classifyCfApiTokenShape(value: string): CfApiTokenShape {
  const token = value.trim();
  // Refused prefixes first: `ghp_` + 36 chars also matches the legacy 40-char shape.
  if (REFUSED_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return 'refused';
  }
  if (CFUT_TOKEN_PATTERN.test(token)) {
    return 'cfut';
  }
  if (LEGACY_CF_TOKEN_PATTERN.test(token)) {
    return 'legacy';
  }
  return 'unknown';
}

function readClipboard(): string | null {
  const platform = process.platform;
  const command =
    platform === 'darwin'
      ? 'pbpaste'
      : platform === 'win32'
        ? 'powershell -NoProfile -Command Get-Clipboard'
        : 'xclip -o -selection clipboard';
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    if (platform !== 'darwin' && platform !== 'win32') {
      try {
        return execSync('wl-paste', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        // No clipboard tool (SSH, CI, a bare Wayland session) — the paste prompt is the path.
      }
    }
    return null;
  }
}

/** `pbcopy </dev/null` and the platform equivalents — best-effort, never throws. */
function clearClipboard(): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync('pbcopy', { input: '' });
    } else if (platform === 'win32') {
      execSync('clip', { input: '' });
    } else {
      try {
        execSync('xclip -selection clipboard', { input: '' });
      } catch {
        execSync('wl-copy', { input: '' });
      }
    }
  } catch {
    // Best-effort: a failure here must not fail the add.
  }
}

export type CfTokenVerification = 'active' | 'inactive' | 'unknown';

/**
 * Local active check. 'unknown' means the check could not run (network or CF error); the
 * caller proceeds and the platform verifies authoritatively. The token is never logged.
 */
async function verifyCfApiToken(token: string): Promise<CfTokenVerification> {
  let res: Response;
  try {
    res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return 'unknown';
  }
  if (res.status === 401 || res.status === 403) {
    return 'inactive';
  }
  if (!res.ok) {
    return 'unknown';
  }
  try {
    const body = (await res.json()) as { result?: { status?: unknown } };
    return body.result?.status === 'active' ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}

/** Mirror of the api's normalization (`normalizeEmailDomain`). */
export function normalizeEmailDomainInput(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Same DNS-hostname shape the api enforces — checked here so junk fails
 * before a grant is ever requested, not after. Real validation stays the
 * platform's zone lookup.
 */
export function isValidEmailDomainInput(domain: string): boolean {
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain);
}

type EnterRace = { promise: Promise<'enter'>; stop: () => void };

/**
 * Resolves when Enter is pressed during the clipboard watch. `stop` removes the listener so
 * a losing race cannot eat the first keystroke of a later prompt.
 */
function createEnterRace(waitForEnter?: () => Promise<unknown>): EnterRace {
  if (waitForEnter) {
    return { promise: waitForEnter().then((): 'enter' => 'enter'), stop: () => {} };
  }
  const stdin = process.stdin;
  let onData: (() => void) | undefined;
  const promise = new Promise<'enter'>((resolve) => {
    if (!stdin.isTTY) {
      return; // Never resolves — non-interactive is gated before any race starts.
    }
    onData = () => resolve('enter');
    stdin.on('data', onData);
  });
  return {
    promise,
    stop: () => {
      if (onData) {
        stdin.removeListener('data', onData);
      }
    },
  };
}

/** Seams for {@link emailDomainAdd} — every browser, clipboard, DNS, and stdin touch is injectable. */
export interface EmailDomainAddDeps {
  dns?: Pick<EmailDns, 'resolveMx'>;
  /** Browser open for the template link (default: auth.ts's openBrowser). */
  openUrl?: (url: string) => void;
  /** Clipboard read; null means no clipboard tool — the paste prompt is the path. */
  readClipboard?: () => string | null;
  clearClipboard?: () => void;
  /** The CF-side active check (default: GET /user/tokens/verify). */
  verifyToken?: (token: string) => Promise<CfTokenVerification>;
  /** The masked paste prompt; null means the user cancelled (Esc). */
  pasteToken?: () => Promise<string | null>;
  /** Confirms the account/zone resource restriction shown in the token form. */
  confirmScope?: (domain: string) => Promise<boolean>;
  /** The Enter keypress that switches paths (default: one stdin line). */
  waitForEnter?: () => Promise<unknown>;
  watchIntervalMs?: number;
  /** Default 10 minutes. */
  watchTimeoutMs?: number;
  /** Sleep between reconcile polls after a lost answer (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Default: wrangler's interactivity gate, same as `void email setup`. */
  isInteractive?: boolean;
  exit?: (code: number) => never;
}

async function defaultPasteToken(): Promise<string | null> {
  const result = await password({
    message: 'Paste the Cloudflare API token:',
    mask: '*',
  });
  if (isCancel(result) || typeof result === 'symbol') {
    return null;
  }
  return result;
}

type EmailDomainCredential = { kind: 'api_token'; apiToken: string };

/**
 * Lost-answer reconcile bounds: attempt-count bounded so the worst case is finite. A lost
 * answer does not stop the API worker, so one immediate status read can 404 while the
 * request is still committing.
 */
const RECONCILE_ATTEMPTS = 15;
const RECONCILE_INTERVAL_MS = 1000;

/**
 * After an add or rotate request fails without a definitive refusal, poll its operation by
 * attempt id and print it. Returns undefined when the operation never appears.
 */
async function reconcileEmailOperation(
  error: unknown,
  client: Pick<PlatformClient, 'getEmailOperation'>,
  projectId: string,
  attemptId: string,
  title: string,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<EmailOperationResponse | undefined> {
  if (error instanceof PlatformApiError && [400, 403, 404, 409].includes(error.status)) {
    throw error;
  }
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RECONCILE_INTERVAL_MS);
    }
    let operation: EmailOperationResponse;
    try {
      operation = await client.getEmailOperation(projectId, attemptId);
    } catch {
      continue;
    }
    note(
      [
        `Operation:   ${operation.operationId}`,
        `Status:      ${operation.status}`,
        `Inbound:     ${operation.readiness.inbound.status}`,
        `Outbound:    ${operation.readiness.outbound.status}`,
        `Credential:  ${operation.readiness.management.status}`,
      ].join('\n'),
      title,
    );
    return operation;
  }
  return undefined;
}

export async function emailDomainAdd(
  client: Pick<
    PlatformClient,
    'addEmailDomain' | 'getEmailOperation' | 'getEmailSettings' | 'listEmailDomains'
  >,
  projectId: string,
  rawDomain: string,
  deps: EmailDomainAddDeps = {},
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const fail = (message: string): never => {
    log.error(message);
    return exit(1);
  };

  const domain = normalizeEmailDomainInput(rawDomain);
  if (!isValidEmailDomainInput(domain)) {
    return fail(`email: invalid domain '${rawDomain}'.`);
  }

  // A foreign MX on the apex stops here; an unreadable one is left to the platform, which
  // re-checks over public DNS.
  const dns = deps.dns ?? (await createNodeEmailDns());
  const checkApexMx = async (adminProject?: string): Promise<void> => {
    const mx = await probeMx(dns, domain);
    if (mx.state === 'unknown') {
      log.info(
        `MX        could not read ${domain}'s MX from here — the platform decides over public DNS.`,
      );
    } else if (mx.state === 'foreign') {
      fail(
        `email: ${domain} already receives mail from another provider. Platform custom inbound email requires an unused Cloudflare zone apex; choose another apex or use the platform shared mail address.${
          adminProject
            ? ` To only send from ${domain}, ask your administrator to run \`void platform email domain-add ${domain} --project ${adminProject} --outbound-only\`.`
            : ''
        }`,
      );
    } else {
      log.info(`MX        using the requested apex ${domain}`);
    }
  };

  // On an administrator-managed platform new domains go to the administrator. An owner row
  // registered before the switch stays the owner's to renew.
  let renewal = false;
  const settings = await client.getEmailSettings(projectId);
  if (settings.domains.management === 'admin') {
    const rows = await client.listEmailDomains(projectId);
    renewal = rows.some((row) => row.domain === domain && row.managed_by !== 'admin');
    if (!renewal) {
      const project = settings.domains.projectSlug ?? projectId;
      await checkApexMx(project);
      log.info(
        [
          'Email domains on this platform are managed by its administrator.',
          'Ask them to run:',
          '',
          `  void platform email domain-add ${domain} --project ${project}`,
          '',
          '`void email domain list` and `void email domain status` keep working here.',
        ].join('\n'),
      );
      return exit(0);
    }
  }

  if (renewal) {
    log.info(`Updating ${domain} with a scoped credential; the platform will reconcile setup.`);
  } else {
    await checkApexMx();
  }

  // Token creation needs a browser or a masked paste prompt.
  const interactive = deps.isInteractive ?? !isWranglerNonInteractiveOrCI();
  if (!interactive) {
    return fail(
      'email: `void email domain add` needs an interactive terminal to create or paste a scoped Cloudflare API token. Run it locally.',
    );
  }

  let credential: EmailDomainCredential;
  {
    log.info(
      `Create a Cloudflare API token restricted to the account and DNS zone containing ${domain}. In the resource selectors, replace All accounts and All zones with those exact resources. Workers Scripts Write still applies to every Worker in the selected account.`,
    );
    const url = buildCfApiTokenTemplateUrl(domain);
    const readClip = deps.readClipboard ?? readClipboard;
    const clearClip = deps.clearClipboard ?? clearClipboard;
    const verify = deps.verifyToken ?? verifyCfApiToken;
    const openUrl = deps.openUrl ?? openBrowser;
    const snapshot = readClip();
    if (snapshot === null) {
      log.info('No clipboard tool found here — paste the token instead.');
    }
    openUrl(url);

    type WatchOutcome = { type: 'token'; token: string } | { type: 'enter' } | { type: 'timeout' };
    let outcome: WatchOutcome;
    let watchSpinner: ReturnType<typeof createSpinner> | undefined;
    if (snapshot === null) {
      outcome = { type: 'timeout' };
    } else {
      watchSpinner = createSpinner();
      watchSpinner.start(
        [
          'Create the token in three clicks: Continue to summary → Create Token → Copy.',
          'Watching the clipboard for it — nothing is read until you copy, and it is cleared afterwards.',
          '(Enter pastes it yourself instead.)',
          `If the browser didn't open, visit:\n${pc.blue(formatUrl(url))}`,
        ].join('\n'),
      );
      const spinner = watchSpinner;
      const deadline = Date.now() + (deps.watchTimeoutMs ?? 10 * 60 * 1000);
      const interval = deps.watchIntervalMs ?? 1000;
      const snapshotTrimmed = snapshot.trim();
      const enterDuringWatch = createEnterRace(deps.waitForEnter);
      // Either race outcome must stop the poll branch, or an orphaned loop keeps reading the
      // clipboard (and could verify a later token) after the flow has moved on.
      let watchSettled = false;
      let watchTimer: ReturnType<typeof setTimeout> | undefined;
      outcome = await Promise.race([
        (async (): Promise<WatchOutcome> => {
          while (!watchSettled && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
              watchTimer = setTimeout(resolve, interval);
            });
            if (watchSettled) {
              break;
            }
            const value = readClip()?.trim();
            if (!value || value === snapshotTrimmed) {
              continue;
            }
            const shape = classifyCfApiTokenShape(value);
            // Wrong shape, including another vendor's token: keep waiting, no network call.
            if (shape === 'refused' || shape === 'unknown') {
              continue;
            }
            const verdict = await verify(value);
            if (verdict === 'inactive') {
              spinner.message('That is not an active Cloudflare token — still waiting.');
              continue;
            }
            if (verdict === 'unknown') {
              log.info(
                'Could not reach Cloudflare to check the token — the platform will verify it.',
              );
            }
            return { type: 'token', token: value };
          }
          return { type: 'timeout' };
        })(),
        enterDuringWatch.promise.then((): WatchOutcome => ({ type: 'enter' })),
      ]);
      watchSettled = true;
      enterDuringWatch.stop();
      // Unref the timer the losing poll branch is parked on — it wakes once,
      // sees the flag and exits; it must not keep the process alive meanwhile.
      watchTimer?.unref();
    }

    if (outcome.type === 'token') {
      clearClip();
      watchSpinner?.stop('Token received — the clipboard copy was cleared.');
      log.info('A clipboard manager may keep its own history — clear it there if you run one.');
      credential = { kind: 'api_token', apiToken: outcome.token };
    } else {
      watchSpinner?.stop(
        outcome.type === 'enter' ? 'Pasting instead.' : 'No token arrived — paste it instead.',
      );
      const pasted = await (deps.pasteToken ?? defaultPasteToken)();
      if (pasted === null) {
        log.info('Cancelled — nothing was stored anywhere.');
        return;
      }
      const token = pasted.trim();
      const shape = classifyCfApiTokenShape(token);
      if (shape === 'refused') {
        return fail(
          'email: that looks like a different kind of token (a GitHub, OpenAI, Slack, or Cloudflare global key) — the link above creates a scoped Cloudflare API token.',
        );
      }
      if (shape === 'unknown') {
        return fail(
          'email: that is not shaped like a Cloudflare API token (`cfut_…` or the legacy 40-character form). Create one from the link above.',
        );
      }
      const verdict = await verify(token);
      if (verdict === 'inactive') {
        return fail('email: that is not an active Cloudflare token.');
      }
      if (verdict === 'unknown') {
        log.info('Could not reach Cloudflare to check the token — the platform will verify it.');
      }
      credential = { kind: 'api_token', apiToken: token };
    }
  }

  const scopeConfirmed = await (
    deps.confirmScope ??
    (async (name: string) => {
      const answer = await confirm({
        message: `Is this token restricted to the Cloudflare account and DNS zone containing ${name}?`,
        initialValue: false,
      });
      return !isCancel(answer) && answer === true;
    })
  )(domain);
  if (!scopeConfirmed) {
    return fail(
      'email: restrict the token to the selected account and zone before adding the domain. Nothing was submitted to the platform.',
    );
  }

  const attemptId = crypto.randomUUID();
  log.info(`Setup operation: ${attemptId}`);
  let row: EmailDomainResponse;
  try {
    row = await client.addEmailDomain(projectId, {
      domain,
      apiToken: credential.apiToken,
      attemptId,
    });
  } catch (error) {
    const operation = await reconcileEmailOperation(
      error,
      client,
      projectId,
      attemptId,
      'Email Setup',
      deps.sleep,
    );
    if (!operation) {
      return fail(
        `email: setup outcome is unknown (operation ${attemptId}). Nothing was revoked. Check \`void email domain status ${domain}\` before starting another setup.`,
      );
    }
    if (operation.error) {
      log.error(operation.error);
    }
    log.info(`Run \`void email domain status ${domain}\` to inspect setup.`);
    if (operation.status === 'completed') {
      printSuccess(`Email domain ${domain} configured.`);
      return;
    }
    return fail(
      `email: setup is ${operation.status}; operation ${operation.operationId} retains its confirmed progress on the platform.`,
    );
  }
  log.info(
    'Token stored encrypted on the platform for this zone connection — nothing is kept on this machine.',
  );
  printEmailDomainOutcome(row);
  if (row.operationStatus !== 'completed') {
    return exit(1);
  }
  printSuccess(`Email domain ${row.domain} configured.`);
}

function emailDomainStatusText(status: EmailDomainResponse['status']): string {
  if (status === 'ready') {
    return pc.green('ready');
  }
  if (status === 'pending') {
    return pc.yellow('pending');
  }
  return status === 'disabled' ? pc.yellow('disabled') : pc.red(status);
}

function printEmailDomainOutcome(row: EmailDomainResponse, projectRef?: string): void {
  const lines = [
    `Domain:      ${row.domain}`,
    `Managed by:  ${row.managed_by === 'admin' ? 'administrator' : 'project owner'}`,
    ...Object.entries(row.readiness).map(
      ([name, value]) =>
        `${name.padEnd(12)} ${value.status}${value.reason ? ' — ' + value.reason : ''}${value.observedAt ? ' (' + value.observedAt + ')' : ''}`,
    ),
  ];
  if (row.operationId) {
    lines.push(
      `Operation:   ${row.operationId}${row.operationStatus ? ' · ' + row.operationStatus : ''}`,
    );
  }
  note(lines.join('\n'), 'Email Domain');
  if (row.error) {
    log.error(row.error);
  }
  if (row.operationStatus === 'unknown') {
    log.warn(
      `Operation ${row.operationId} has an unknown outcome; inspect its status before retrying.`,
    );
    return;
  }
  if (
    row.readiness.management.status === 'expired' ||
    row.readiness.management.status === 'revoked'
  ) {
    log.info(
      row.managed_by === 'admin'
        ? `Ask your administrator to run \`void platform email domain-add ${row.domain} --project ${projectRef ?? row.projectId}\` with a renewed credential.`
        : `Run \`void email domain add ${row.domain}\` with a new scoped API token.`,
    );
  } else if (
    row.readiness.inbound.status === 'pending' ||
    row.readiness.inbound.status === 'drifted'
  ) {
    log.info(
      row.managed_by === 'admin'
        ? `Ask your administrator to run \`void platform email domain-sync ${row.domain}\` to reconcile setup.`
        : `Run \`void email domain sync ${row.domain}\` to reconcile setup.`,
    );
  }
}

export async function emailDomainStatus(
  client: Pick<PlatformClient, 'getEmailDomain' | 'getEmailSettings'>,
  projectId: string,
  rawDomain: string,
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const row = await client.getEmailDomain(projectId, domain);
  const projectRef =
    row.managed_by === 'admin'
      ? ((await client.getEmailSettings(projectId)).domains.projectSlug ?? projectId)
      : undefined;
  printEmailDomainOutcome(row, projectRef);
}

export async function emailDomainList(
  client: Pick<PlatformClient, 'listEmailDomains'>,
  projectId: string,
): Promise<void> {
  const rows = await client.listEmailDomains(projectId);
  if (rows.length === 0) {
    log.info(
      'No email domains. Run `void email domain add <domain>` to send and receive at your own domain on a Cloudflare zone.',
    );
    return;
  }
  const width = Math.max(...rows.map((row) => row.domain.length));
  const lines = rows.map(
    (row) =>
      `  ${row.domain.padEnd(width)}  ${emailDomainStatusText(row.status)}  ${row.managed_by === 'admin' ? 'administrator' : 'project owner'}`,
  );
  note(lines.join('\n'), 'Email Domains');
}

export async function emailDomainSync(
  client: Pick<PlatformClient, 'syncEmailDomain'>,
  projectId: string,
  rawDomain: string,
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const row = await client.syncEmailDomain(projectId, domain);
  printEmailDomainOutcome(row);
  if (row.operationStatus !== 'completed') {
    throw new Error(
      `email: reconciliation ${row.operationStatus ?? 'pending'}; inspect operation ${row.operationId ?? row.domain}`,
    );
  }
  printSuccess(`Email domain ${domain} reconciled.`);
}

/** Rotation applies to every domain sharing this zone connection. */
export async function emailDomainRotateSecret(
  client: Pick<PlatformClient, 'rotateEmailDomainSecret' | 'getEmailOperation'>,
  projectId: string,
  rawDomain: string,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const attemptId = crypto.randomUUID();
  let row: EmailDomainResponse;
  try {
    row = await client.rotateEmailDomainSecret(projectId, domain, attemptId);
  } catch (error) {
    const operation = await reconcileEmailOperation(
      error,
      client,
      projectId,
      attemptId,
      'Email Secret Rotation',
      deps.sleep,
    );
    if (!operation) {
      throw new Error(
        `email: secret rotation outcome is unknown (operation key ${attemptId}); inspect \`void email domain status ${domain}\` before starting another rotation.`,
      );
    }
    if (operation.status !== 'completed') {
      throw new Error(
        `email: secret rotation ${operation.status}; inspect operation ${operation.operationId}`,
      );
    }
    printSuccess('Zone ingress secret rotated and verified on the deployed Worker.');
    return;
  }
  printEmailDomainOutcome(row);
  if (row.operationStatus !== 'completed') {
    throw new Error(
      `email: secret rotation ${row.operationStatus ?? 'pending'}; inspect operation ${row.operationId ?? row.domain}`,
    );
  }
  printSuccess('Zone ingress secret rotated and verified on the deployed Worker.');
}

export async function emailDomainRemove(
  client: Pick<PlatformClient, 'removeEmailDomain'>,
  projectId: string,
  rawDomain: string,
  options: { exit?: (code: number) => never } = {},
): Promise<void> {
  const domain = normalizeEmailDomainInput(rawDomain);
  const result = await client.removeEmailDomain(projectId, domain);
  log.info(`Operation: ${result.operationId} · ${result.operationStatus ?? 'pending'}`);
  if (!result.removed || result.operationStatus !== 'completed') {
    log.error(
      result.error ??
        'Email cleanup is not complete. Its operation and resources remain recorded for reconciliation.',
    );
    (options.exit ?? ((code: number): never => process.exit(code)))(1);
    return;
  }
  printSuccess(`Removed ${domain}. Zone resources still used by other domains were retained.`);
}

async function runEmailDomainCommand(
  client: PlatformClient,
  projectId: string,
  args: EmailArgs,
): Promise<void> {
  switch (args.domainVerb) {
    case 'add':
      return emailDomainAdd(client, projectId, args.domain!);
    case 'status':
      return emailDomainStatus(client, projectId, args.domain!);
    case 'list':
      return emailDomainList(client, projectId);
    case 'sync':
      return emailDomainSync(client, projectId, args.domain!);
    case 'rotate-secret':
      return emailDomainRotateSecret(client, projectId, args.domain!);
    case 'remove':
      return emailDomainRemove(client, projectId, args.domain!);
  }
}

// ── --platform cloudflare: the developer's own Cloudflare account ───────────────

/** Test seams for {@link runEmailCloudflareCommand}. */
export interface EmailCloudflareCommandDeps {
  /** Runner for the provider reads and the `enable` writes. */
  runWrangler?: EmailWranglerRun;
  /** The session-bearer bridge (default: `runWranglerAuthToken`). */
  getSessionBearer?: () => Promise<string | null>;
  fetchImpl?: EmailFetch;
  dns?: EmailDns;
  /** Override the interactivity gate (default: `!isWranglerNonInteractiveOrCI()`). */
  isInteractive?: boolean;
  /** Setup confirmation (default: clack `confirm`, default Yes). */
  confirm?: (message: string) => Promise<boolean>;
  /** Block printer for the checklist / address map (default: clack `log.message`). */
  print?: (block: string) => void;
  exit?: (code: number) => never;
}

interface EmailWranglerConfigContext {
  path: string;
  cleanup: () => void;
}

/**
 * Wrangler finds config by walking parent directories, so an app with no root config runs in
 * an empty temporary one; otherwise an unrelated ancestor config could select the wrong account.
 */
function createEmailWranglerConfigContext(configPath: string): EmailWranglerConfigContext {
  if (existsSync(configPath)) {
    return { path: configPath, cleanup: () => {} };
  }

  const directory = mkdtempSync(join(tmpdir(), 'void-email-wrangler-'));
  const path = join(directory, 'wrangler.jsonc');
  try {
    writeFileSync(path, '{}\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * `void email setup|status --platform cloudflare`.
 *
 * `setup` runs the deploy's email step on its own: preflight, checklist, one confirmation,
 * apply, then a write of the generated Cloudflare config and void.lock.json. A CI deploy that
 * finds email not ready says to run it once locally, commit void.lock.json, and redeploy; the
 * next deploy creates the routing rules from `addresses`. It is also the only place that
 * retries a sending onboarding the committed binding records as refused (Workers Free).
 *
 * `status` prints the preflight and exits 1 when email is not ready.
 */
export async function runEmailCloudflareCommand(
  root: string,
  args: EmailArgs,
  deps: EmailCloudflareCommandDeps = {},
): Promise<void> {
  const rawExit = deps.exit ?? ((code: number): never => process.exit(code));
  // Keep project validation ahead of Cloudflare-config discovery, including its legacy-TOML
  // refusal. No config context is needed until the command is ready to make account reads.
  const voidConfig = readConfig(root);
  const from = voidConfig.email?.from;
  if (!from) {
    log.error(
      'email: no sender configured. Set email.from to "you@mail.acme.com" in void.config.ts — its host is the domain email is set up on.',
    );
    return rawExit(1);
  }
  const paths = readProjectPaths(root);
  const handlers = scanEmailHandlersSync(paths.sourceRoot);

  const configPath = discoverRootWranglerConfig(root);
  const wranglerConfig = createEmailWranglerConfigContext(configPath);
  try {
    return await runEmailCloudflareCommandInConfig(
      root,
      args,
      { from, handlers },
      configPath,
      wranglerConfig.path,
      {
        ...deps,
        exit: (code: number): never => {
          wranglerConfig.cleanup();
          return rawExit(code);
        },
      },
    );
  } finally {
    wranglerConfig.cleanup();
  }
}

async function runEmailCloudflareCommandInConfig(
  root: string,
  args: EmailArgs,
  project: {
    from: string;
    handlers: ReturnType<typeof scanEmailHandlersSync>;
  },
  configPath: string,
  wranglerConfigPath: string,
  deps: EmailCloudflareCommandDeps,
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const print = deps.print ?? ((block: string): void => log.message(block));
  const fail = (message: string): never => {
    log.error(message);
    return exit(1);
  };

  // 1. Inputs from the local project: `email.from` is the only domain input.
  const { from, handlers } = project;

  // 2. The same pinned transport + account + worker name as `void deploy --platform
  //    cloudflare`, so every wrangler child here consults the account the deploy will.
  const rootConfig = parseRootWranglerConfig(configPath);
  let apiBaseUrl: string;
  try {
    apiBaseUrl = resolveDeployTransport(root, rootConfig);
  } catch (err) {
    return fail(`email: ${err instanceof Error ? err.message : String(err)}`);
  }
  const accountId =
    readWranglerTopLevelString(rootConfig, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    return fail(
      [
        'email: no Cloudflare account is pinned.',
        'Set `cloudflare.account_id` in void.config.ts, or export CLOUDFLARE_ACCOUNT_ID —',
        'the same pin `void deploy --platform cloudflare` needs.',
      ].join('\n'),
    );
  }
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  const runWrangler = deps.runWrangler ?? createDeployWranglerRunner(root, accountId, apiBaseUrl);
  const getSessionBearer =
    deps.getSessionBearer ?? (() => runWranglerAuthToken(runWrangler, wranglerConfigPath));
  const inputs: EmailCloudflareInputs = {
    handlers,
    from,
    workerName,
    accountId,
    ...emailConfigInputs(rootConfig),
    configPath: wranglerConfigPath,
    apiBaseUrl,
    runWrangler,
    getSessionBearer,
    fetchImpl: deps.fetchImpl ?? fetch,
    dns: deps.dns ?? (await createNodeEmailDns()),
  };

  // 3. Preflight — read-only.
  let pre: EmailPreflight;
  try {
    pre = await preflightEmail(inputs);
  } catch (err) {
    return fail(`email: ${err instanceof Error ? err.message : String(err)}`);
  }
  print(renderEmailChecklist(pre));

  if (args.subcommand === 'status') {
    print(
      renderAddressMap({
        from,
        routes: pre.derived.routes,
        addresses: pre.rules.mine,
        sendingReady: pre.sending.state === 'ready',
        pendingLabel: '(no rule yet)',
      }),
    );
    if (pre.ready) {
      log.info(`Email is set up on ${pre.domain}.`);
      return;
    }
    log.warn(
      `Email is not set up on ${pre.domain} yet — run \`void email setup --platform cloudflare\`.`,
    );
    return exit(1);
  }

  // 4. Confirm. A ready preflight needs no prompt, except a sending onboarding the committed
  //    binding records as refused: apply would retry it, so it gets its own prompt.
  if (pre.blockers.some((b) => b.scope === 'all')) {
    return fail('email: nothing was changed — fix the ✘ rows above and rerun.');
  }
  if (!pre.ready || pre.sendingRetryable) {
    const interactive = deps.isInteractive ?? !isWranglerNonInteractiveOrCI();
    if (!interactive) {
      return fail(
        'email: `void email setup` changes your Cloudflare account, so it needs an interactive terminal. Run it locally once, commit void.lock.json, then redeploy.',
      );
    }
    const ask =
      deps.confirm ??
      (async (message: string): Promise<boolean> => {
        const answer = await confirm({ message, initialValue: true });
        return !isCancel(answer) && answer === true;
      });
    const question = pre.ready
      ? `Onboard ${pre.domain} for Email Sending? Inbound already works; onboarding needs Workers Paid.`
      : `Set up email on ${pre.domain}?`;
    if (!(await ask(question))) {
      log.info('Nothing changed.');
      return;
    }
  }

  // 5. Apply, then write the config patch.
  const out = await applyEmailSetup(pre, inputs);
  if (out.lines.length > 0) {
    print(out.lines.join('\n'));
  }
  try {
    writeProvisionedWranglerConfig(root, out.patch, { configPath });
  } catch (err) {
    return fail(
      `email: could not update ${configPath} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  print(
    renderAddressMap({
      from,
      routes: pre.derived.routes,
      addresses: out.patch.addresses ?? [],
      sendingReady: out.sendingReady,
      pendingLabel: '(no rule yet)',
    }),
  );
  // Inbound must be complete, as `--require-email` checks the same `inboundReady`. A sending
  // row left pending (Workers Free) is not a failure: the written binding records it.
  if (!out.inboundReady) {
    const missing = !out.routingReady
      ? `Email Routing on ${pre.domain} is not ready`
      : !out.subaddressingReady
        ? `subaddressing on ${pre.apex} is still off (support+anything@ would not reach support@)`
        : '`addresses` was withheld';
    log.warn(
      `Email is not set up on ${pre.domain} yet — ${missing}; no routing rule is created until it is. Finish the step above, then rerun \`void email setup --platform cloudflare\`.`,
    );
    return exit(1);
  }
  if ((out.patch.addresses ?? []).length > 0) {
    log.info(
      'Routing rules are created by the next `void deploy --platform cloudflare`, which applies the Email Routing plan from `addresses`.',
    );
  }
  printSuccess(`Email set up on ${pre.domain}.`);
}
