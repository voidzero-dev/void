import { confirm, isCancel, log, outro } from '@voidzero-dev/vite-plus-prompts';
import { isCI } from 'ci-info';
import { getToken } from './auth.ts';
import {
  PlatformApiError,
  PlatformClient,
  type ProjectZeroTrustResponse,
  type ProjectZeroTrustUpdateResponse,
} from './client.ts';
import { printSuccess, note, sanitizeTerminalText } from './output.ts';
import type { ProjectZeroTrustArgs } from './project-args.ts';
import { cleanLine, publicRequestLines } from './project-security.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, requireProjectBySlug } from './resolve-project.ts';
import type { ProjectSecurityStatus, SecurityPublicRequest } from './security-api-types.ts';

type ZeroTrustArgs = Exclude<ProjectZeroTrustArgs, { action: '' }>;

export type ProjectZeroTrustDeps = {
  interactive?: boolean;
  confirm?: (message: string) => Promise<boolean>;
};

const OPEN_REQUEST_STATES = ['waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy'];

function isOpenRequest(request: SecurityPublicRequest | null | undefined): boolean {
  return Boolean(request && OPEN_REQUEST_STATES.includes(request.state));
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

function requestBlock(
  slug: string,
  request: SecurityPublicRequest,
  security: Pick<ProjectSecurityStatus, 'backlogFiles' | 'budget'>,
): Array<string> {
  const [first = '', ...rest] = publicRequestLines(slug, request, security);
  return [`Public request: ${first}`, ...rest.map((line) => `  ${line}`)];
}

function statusLines(
  result: ProjectZeroTrustResponse,
  security: Pick<ProjectSecurityStatus, 'backlogFiles' | 'budget'>,
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
      ? requestBlock(slug, result.publicRequest!, security)
      : []),
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

function urgentRefusal(slug: string, error: PlatformApiError): Error | null {
  let body: { error?: unknown; blockers?: { ids?: unknown } };
  try {
    body = JSON.parse(error.body) as typeof body;
  } catch {
    return null;
  }
  if (body.error === 'no public request') {
    return new Error(
      `project: ${slug} has no public request to bypass. Run: void project zero-trust public`,
    );
  }
  if (body.error !== 'security public request has urgent findings') {
    return null;
  }
  const ids = Array.isArray(body.blockers?.ids)
    ? body.blockers.ids.filter((id): id is string => typeof id === 'string').map(cleanLine)
    : [];
  const count = ids.length;
  return new Error(
    `project: ${slug} has ${count} urgent ${count === 1 ? 'finding' : 'findings'} open (${ids.join(', ')}). A bypass skips only the scan, not open findings.\n  Resolve them first: fixed (then deploy the fix), or false-positive / accepted-risk with a comment.\n  Then the request unlocks.   → void project security list --urgent`,
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
  const why = request.heldReason ? cleanLine(request.heldReason.split('_').join(' ')) : '';
  return `The scan of ${target} did not finish${why ? ` (${why})` : ''}.`;
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
    throw new Error(
      `project: ${slug} has no public request to bypass. Run: void project zero-trust public`,
    );
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
    result = await client.bypassProjectPublicRequest(projectId, args.reason);
  } catch (error) {
    if (error instanceof PlatformApiError && error.status === 409) {
      throw urgentRefusal(slug, error) ?? error;
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
    let security: Pick<ProjectSecurityStatus, 'backlogFiles' | 'budget'> = {
      backlogFiles: 0,
      budget: null,
    };
    if (isOpenRequest(result.publicRequest)) {
      try {
        security = await client.getProjectSecurity(projectId);
      } catch {
        // The request copy still reads right without the backlog and budget lines.
      }
    }
    note(statusLines(result, security, slug), slug);
    outro(`${slug} Zero Trust status`);
    return;
  }
  const result: ProjectZeroTrustUpdateResponse =
    args.action === 'reconcile'
      ? await client.reconcileProjectZeroTrust(projectId)
      : await client.setProjectZeroTrust(projectId, args.action === 'protect');
  const held =
    args.action === 'public' && result.publicRequest && isOpenRequest(result.publicRequest);
  if (args.json) {
    printJson(held ? heldJson(result) : result);
    return;
  }
  if (held) {
    // Held for a scan: the project stays protected, so nothing here says "public".
    const copy = result.message
      ? sanitizeTerminalText(result.message)
      : publicRequestLines(slug, result.publicRequest!, { backlogFiles: 0, budget: null }).join(
          '\n',
        );
    log.warn(copy);
    outro(`${slug} stays protected by Zero Trust until the request clears.`);
    return;
  }
  if (result.project.last_error) {
    log.warn(sanitizeTerminalText(result.project.last_error));
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
    args.action === 'protect'
      ? `${slug} is protected by Zero Trust.`
      : args.action === 'public'
        ? `${slug} is public.`
        : `${slug} Zero Trust reconciled (${result.project.state}).`,
  );
}
