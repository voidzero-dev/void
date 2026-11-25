import { confirm, isCancel, log, outro } from '@voidzero-dev/vite-plus-prompts';
import { isCI } from 'ci-info';
import { getToken } from './auth.ts';
import { PlatformApiError, PlatformClient } from './client.ts';
import type { ProjectZeroTrustResponse, ProjectZeroTrustUpdateResponse } from './client.ts';
import { printSuccess, note, sanitizeTerminalText } from './output.ts';
import type { ProjectZeroTrustArgs } from './project-args.ts';
import { cleanLine, day, publicRequestLines } from './project-security.ts';
import type { RequestSecurity } from './project-security.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, requireProjectBySlug } from './resolve-project.ts';
import type { SecurityPublicRequest } from './security-api-types.ts';

type ZeroTrustArgs = Exclude<ProjectZeroTrustArgs, { action: '' }>;

export type ProjectZeroTrustDeps = {
  interactive?: boolean;
  confirm?: (message: string) => Promise<boolean>;
};

const OPEN_REQUEST_STATES = new Set([
  'waiting_scan',
  'held_findings',
  'held_no_result',
  'needs_deploy',
]);

function isOpenRequest(
  request: SecurityPublicRequest | null | undefined,
): request is SecurityPublicRequest {
  return Boolean(request && OPEN_REQUEST_STATES.has(request.state));
}

async function resolveTarget(root: string, args: ZeroTrustArgs) {
  const token = getToken(root);
  if (!token) {
    throw new Error('project: Not logged in. Run `void account login` first.');
  }
  const client = new PlatformClient(token, { root });
  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectSlug });
  if (requestedSlug) {
    const project = await requireProjectBySlug(client, requestedSlug);
    return { client, projectId: project.projectId, slug: project.slug };
  }
  const linked = readProjectConfig(root);
  if (!linked) {
    throw new Error('project: No linked project. Pass --project <name> or set VOID_PROJECT.');
  }
  return { client, projectId: linked.projectId, slug: linked.slug };
}

/**
 * A refusal that keeps the platform's error code, status and details (blockers, the
 * closed request's state), so `--json` prints them (cli-main).
 */
class ZeroTrustRefusal extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details: Record<string, unknown>;
  constructor(
    message: string,
    code: string,
    status: number | undefined,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
    this.details = details;
  }
}

function noRequestRefusal(slug: string, status?: number): ZeroTrustRefusal {
  return new ZeroTrustRefusal(
    `project: ${slug} has no public request to bypass. Run: void project zero-trust public`,
    'no public request',
    status,
  );
}

function roleLabel(role: string | null): string {
  switch (role) {
    case 'owner':
      return 'the project owner';
    case 'admin':
      return 'a project admin';
    case 'installation_admin':
      return 'a platform admin';
    default:
      return 'a project member';
  }
}

function lastBypassLine(bypass: NonNullable<ProjectZeroTrustResponse['lastBypass']>): string {
  const reason = bypass.reason === undefined ? '' : ` ("${cleanLine(bypass.reason)}")`;
  return `Last bypass: ${day(bypass.at)}, by ${roleLabel(bypass.byRole)}${reason}`;
}

function requestBlock(
  slug: string,
  request: SecurityPublicRequest,
  security: RequestSecurity,
): Array<string> {
  const [first = '', ...rest] = publicRequestLines(slug, request, security);
  return [`Public request: ${first}`, ...rest.map((line) => `  ${line}`)];
}

function statusLines(
  result: ProjectZeroTrustResponse,
  security: RequestSecurity,
  slug: string,
): string {
  const project = result.project;
  const platformStatus = sanitizeTerminalText(result.platformStatus);
  const unavailableMessage =
    result.platformStatus === 'invalid_configuration'
      ? 'The platform Zero Trust configuration is invalid. Ask a platform administrator to review it.'
      : result.platformStatus === 'configuring'
        ? 'The platform is still applying Zero Trust configuration. A platform administrator can resume it with `void platform zero-trust reconcile`.'
        : result.platformStatus === 'disabling'
          ? 'The platform is disabling project Zero Trust. A platform administrator can resume it with `void platform zero-trust reconcile`.'
          : result.platformStatus === 'error'
            ? 'The platform Zero Trust configuration needs administrator attention. A platform administrator can inspect its status and reconcile it.'
            : result.platformStatus === 'ready'
              ? 'The platform administrator has disabled project Zero Trust.'
              : 'The platform administrator has not configured project Zero Trust.';
  return [
    `Available: ${result.available ? 'yes' : 'no'}`,
    `Platform: ${platformStatus}`,
    ...(result.platformStatus === 'not_configured' ||
    result.platformStatus === 'invalid_configuration'
      ? []
      : [`Default for new projects: ${result.protectNewProjects ? 'protected' : 'public'}`]),
    `Desired: ${project ? (project.desired_protected ? 'protected' : 'public') : 'not initialized'}`,
    `Effective: ${project ? (project.effective_protected ? 'protected' : 'public') : 'not initialized'}`,
    `State: ${project?.state ?? 'not initialized'}`,
    ...(project?.last_error ? [`Last error: ${sanitizeTerminalText(project.last_error)}`] : []),
    ...(!result.available ? [unavailableMessage] : []),
    ...(isOpenRequest(result.publicRequest)
      ? requestBlock(slug, result.publicRequest, security)
      : []),
    ...(result.lastBypass ? [lastBypassLine(result.lastBypass)] : []),
  ].join('\n');
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** The reply of a held request as JSON: the stored state, never the old-CLI stand-in. */
function heldJson(result: ProjectZeroTrustUpdateResponse) {
  return {
    ...result,
    held: true,
    project: { ...result.project, state: 'protected' as const, last_error: null },
  };
}

function closedRefusalText(slug: string, state: string, fallback: string): string {
  switch (state) {
    case 'canceled':
      return `project: Public request canceled, so nothing was bypassed. ${slug} stays protected.`;
    case 'passed':
      return `project: The security scan already passed, so nothing was bypassed. ${slug} is going public.`;
    case 'bypassed':
      return `project: The scan was already bypassed. ${slug} is going public.`;
    default:
      return fallback;
  }
}

/** The CLI copy of a 409 from the bypass route, keeping its code; else `null`. */
function bypassRefusal(slug: string, error: PlatformApiError): ZeroTrustRefusal | null {
  let body: { error?: unknown; state?: unknown; blockers?: { count?: unknown; ids?: unknown } };
  try {
    body = JSON.parse(error.body) as typeof body;
  } catch {
    return null;
  }
  if (body.error === 'no public request') {
    return noRequestRefusal(slug, error.status);
  }
  if (body.error === 'public request closed') {
    // A protect, a pass or another bypass closed the request this bypass saw (edge #72).
    const state = typeof body.state === 'string' ? body.state : '';
    return new ZeroTrustRefusal(
      closedRefusalText(slug, state, error.message),
      body.error,
      error.status,
      { state },
    );
  }
  if (body.error !== 'security public request has urgent findings') {
    return null;
  }
  const ids = Array.isArray(body.blockers?.ids)
    ? body.blockers.ids.filter((id): id is string => typeof id === 'string').map(cleanLine)
    : [];
  const count = ids.length;
  return new ZeroTrustRefusal(
    `project: ${slug} has ${count} urgent ${count === 1 ? 'finding' : 'findings'} open (${ids.join(', ')}). A bypass skips only the scan, not open findings.\n  Resolve them first: fixed (then deploy the fix), or false-positive / accepted-risk with a comment.\n  Then the request unlocks.   → void project security list --urgent`,
    body.error,
    error.status,
    { blockers: { count, ids } },
  );
}

function skipLine(request: SecurityPublicRequest): string {
  const target = cleanLine(request.targetDeploymentId);
  if (request.state === 'waiting_scan') {
    return `The scan of ${target} has not finished.`;
  }
  if (request.state === 'needs_deploy') {
    return request.heldReason === 'unproven_fix'
      ? 'A fix you resolved is not checked by a scan yet.'
      : `The live deployment ${target} cannot be scanned until you deploy again.`;
  }
  if (request.heldReason === 'unread_files') {
    return `The scan of ${target} could not read some project files.`;
  }
  const why = request.heldReason ? cleanLine(request.heldReason.split('_').join(' ')) : '';
  return `The scan of ${target} did not finish${why ? ` (${why})` : ''}.`;
}

const NO_SECURITY: RequestSecurity = {
  backlogFiles: 0,
  budget: null,
};

/**
 * The backlog, budget, gate scan and model the request copy names; without them it
 * still reads right.
 */
async function requestSecurity(
  client: PlatformClient,
  projectId: string,
): Promise<RequestSecurity> {
  try {
    const status = await client.getProjectSecurity(projectId);
    return {
      backlogFiles: typeof status.backlogFiles === 'number' ? status.backlogFiles : 0,
      budget: status.budget ?? null,
      lastScan: status.lastScan ?? null,
      model: status.model,
      projectId,
    };
  } catch {
    return { ...NO_SECURITY, projectId };
  }
}

async function runBypass(
  args: Extract<ZeroTrustArgs, { action: 'bypass' }>,
  target: { client: PlatformClient; projectId: string; slug: string },
  deps: ProjectZeroTrustDeps,
): Promise<void> {
  const { client, projectId, slug } = target;
  const state = await client.getProjectZeroTrust(projectId);
  // An old platform sends no request field; the bypass route then answers with the
  // "does not support security audits" copy.
  if (state.publicRequest === null) {
    throw noRequestRefusal(slug);
  }
  const request = state.publicRequest;
  if (request && !args.yes && request.state !== 'held_findings') {
    const interactive = deps.interactive ?? (Boolean(process.stdout.isTTY) && !isCI);
    if (args.json || !interactive) {
      throw new Error('project: Add --yes to bypass the scan without a prompt.');
    }
    const ask =
      deps.confirm ??
      (async (message: string) => {
        const answer = await confirm({ message, initialValue: false });
        return !isCancel(answer) && answer;
      });
    log.info(
      [
        'This skips the security scan. ' + skipLine(request),
        'Your platform admins get an email with your reason, and the bypass is recorded.',
      ].join('\n'),
    );
    if (!(await ask(`Bypass the scan and make ${slug} public?`))) {
      outro('Nothing was changed.');
      return;
    }
  }
  let result;
  try {
    result = await client.bypassProjectPublicRequest(projectId, args.reason, request?.id);
  } catch (error) {
    if (error instanceof PlatformApiError && error.status === 409) {
      throw bypassRefusal(slug, error) ?? error;
    }
    throw error;
  }
  if (args.json) {
    printJson(result);
    return;
  }
  if (result.project?.last_error) {
    log.warn(sanitizeTerminalText(result.project.last_error));
  }
  const settled =
    result.project?.state === 'public' &&
    !result.project.desired_protected &&
    !result.project.effective_protected;
  printSuccess(
    settled
      ? `Scan bypassed. ${slug} is public.`
      : `Scan bypassed. ${slug} is going public (Zero Trust update in progress).`,
  );
}

export async function runProjectZeroTrustCommand(
  root: string,
  args: ZeroTrustArgs,
  deps: ProjectZeroTrustDeps = {},
): Promise<void> {
  if (!args.json) {
    console.log();
  }
  const target = await resolveTarget(root, args);
  const { client, projectId, slug } = target;
  if (args.action === 'bypass') {
    return runBypass(args, target, deps);
  }
  if (args.action === 'status') {
    const result = await client.getProjectZeroTrust(projectId);
    if (args.json) {
      printJson(result);
      return;
    }
    const security = isOpenRequest(result.publicRequest)
      ? await requestSecurity(client, projectId)
      : NO_SECURITY;
    note(statusLines(result, security, slug), slug);
    outro(`${slug} Zero Trust status`);
    return;
  }
  const result: ProjectZeroTrustUpdateResponse =
    args.action === 'reconcile'
      ? await client.reconcileProjectZeroTrust(projectId)
      : await client.setProjectZeroTrust(projectId, args.action === 'protect');
  const publicRequest = result.publicRequest;
  const held = args.action === 'public' && isOpenRequest(publicRequest);
  if (args.json) {
    printJson(held ? heldJson(result) : result);
    return;
  }
  if (held) {
    // Held for a scan: the project stays protected, so nothing here says "public". The
    // local copy adds the command lines (spec §13.3) the platform message leaves out.
    const security = await requestSecurity(client, projectId);
    log.warn(publicRequestLines(slug, publicRequest, security).join('\n'));
    outro('Check it:  void project zero-trust status');
    return;
  }
  // Protect closed an open request (edge #80): say so (spec §11.4).
  const canceled = args.action === 'protect' && result.publicRequest?.state === 'canceled';
  const canceledLine = `Public request canceled. ${slug} stays protected.`;
  if (result.project.last_error) {
    log.warn(sanitizeTerminalText(result.project.last_error));
  }
  const settledProtect =
    result.project.state !== 'reconciling' &&
    result.project.state !== 'error' &&
    !result.project.last_error;
  if (canceled && !settledProtect) {
    log.info(canceledLine);
  }
  if (result.project.state === 'reconciling') {
    outro(
      `${slug} Zero Trust update is still in progress. Run \`void project zero-trust reconcile\` to continue, or wait for scheduled maintenance.`,
    );
    return;
  }
  if (result.project.last_error || result.project.state === 'error') {
    outro(`${slug} Zero Trust needs attention (${result.project.state}).`);
    return;
  }
  printSuccess(
    canceled
      ? canceledLine
      : args.action === 'protect'
        ? `${slug} is protected by Zero Trust.`
        : args.action === 'public'
          ? `${slug} is public.`
          : `${slug} Zero Trust reconciled (${result.project.state}).`,
  );
}
