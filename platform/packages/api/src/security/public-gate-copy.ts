/**
 * Public request copy (spec §11.4 "Public request copy", §5.5 bypass refusal). Pure.
 * The CLI and the page add their own command lines; these are the sentences the API
 * itself returns (`message` of the 202 reply, the bypass 409).
 */
import { SECURITY_GATE_UNREAD_FILES } from './public-gate-judge.ts';
import type { SecurityPublicRequestState } from './schema.ts';

export type PublicRequestCopyInput = Readonly<{
  slug: string;
  state: SecurityPublicRequestState;
  /** `held_reason` code. */
  reason: string | null;
  blockerIds: ReadonlyArray<string>;
  deploymentId: string;
  backlogFiles?: number;
}>;

function ids(list: ReadonlyArray<string>): string {
  return list.join(', ');
}

function noResultCause(reason: string | null): string {
  switch (reason) {
    case 'refused':
      return 'refused';
    case 'timed_out':
      return 'timed out';
    case 'findings_capped':
      return 'it hit the findings limit, so more findings may be hidden';
    case 'failed_installation':
      return 'the platform could not run the scan (an installation problem, not your code); your platform admins were told';
    case 'failed_project':
      return 'the scan of this project failed';
    case 'skipped_budget':
      return 'the monthly scan budget is used up, so the scan could not run';
    default:
      return reason ? reason.split('_').join(' ') : 'no result';
  }
}

/**
 * `waiting_scan` says what it waits for: the scan, or (`held_reason`) a deploy that is
 * going live, or the project's Zero Trust row (edge #75, #86). The CLI has the same rule.
 */
function waitingCopy(
  slug: string,
  deploymentId: string,
  reason: string | null,
  backlogFiles: number,
): string {
  if (reason === 'deployment_moving') {
    return `Waiting for the new deployment to go live before ${slug} goes public. It stays protected by Zero Trust until the scan of that deployment passes.`;
  }
  if (reason === 'zero_trust_not_ready') {
    return `Waiting for the Zero Trust protection of ${slug} to be ready before it goes public. It stays protected until then. See: void project zero-trust status`;
  }
  return backlogFiles > 0
    ? `Scanning in parts: ${backlogFiles} files left. ${slug} stays protected until every file is scanned.`
    : `Waiting for a security scan of ${deploymentId} before ${slug} goes public. It stays protected by Zero Trust until the scan passes.`;
}

export function publicRequestCopy(input: PublicRequestCopyInput): string {
  const { slug, deploymentId } = input;
  switch (input.state) {
    case 'waiting_scan':
      return waitingCopy(slug, deploymentId, input.reason, input.backlogFiles ?? 0);
    case 'held_findings': {
      const count = input.blockerIds.length;
      return `Stays protected: ${count} urgent ${count === 1 ? 'finding' : 'findings'} must be resolved before Zero Trust is turned off (${ids(input.blockerIds)}). Resolve each one as fixed (then deploy the fix), or as false_positive or accepted_risk with a comment; then the request unlocks.`;
    }
    case 'needs_deploy':
      return input.reason === 'unproven_fix'
        ? `Stays protected: ${ids(input.blockerIds)} ${input.blockerIds.length === 1 ? 'was' : 'were'} resolved as fixed. Deploy the fix (if it is already live, deploy again); ${slug} goes public when the scan of that deploy is clean.`
        : `Stays protected: the live deployment ${deploymentId} cannot be scanned (its code was not kept for scanning). Deploy again; that deploy is scanned before ${slug} goes public.`;
    case 'held_no_result':
      return input.reason === SECURITY_GATE_UNREAD_FILES
        ? `Stays protected: the security scan could not read some project files (too large, not text, or a path the scanner cannot send). Fix them and deploy again, or bypass the scan with a reason.`
        : `Stays protected: the security scan did not finish (${noResultCause(input.reason)}). Ask again, deploy again, or bypass the scan with a reason.`;
    case 'passed':
      return `Security scan passed (nothing urgent found). Zero Trust is being turned off for ${slug}.`;
    case 'bypassed':
      return `Public without a clean scan: the scan was bypassed. Your platform admins were told.`;
    case 'canceled':
      return `Public request canceled. ${slug} stays protected.`;
  }
}

/** The line an old CLI prints as a warning while a request holds the project (spec §13.3). */
export function oldCliHeldLine(slug: string): string {
  return `${slug} stays protected until a security scan passes (public request). Reconcile does not speed this up; you get an email. To bypass, update the void CLI.`;
}

/** 409 `zero trust not ready` of a bypass (edge #89): nothing was recorded. */
export function bypassNotReadyRefusal(cause: string): string {
  return `Zero Trust protection for this project is not ready: ${cause} The scan was not bypassed and nothing was recorded. Try again after it ends. See: void project zero-trust status`;
}

/** 409 `security public request has urgent findings`. */
export function urgentFindingsRefusal(ids_: ReadonlyArray<string>): string {
  const count = ids_.length;
  return `${count} urgent ${count === 1 ? 'finding is' : 'findings are'} open (${ids(ids_)}). Resolve them first: resolve as fixed and deploy the fix, or as false_positive or accepted_risk with a comment. Then the request unlocks.`;
}
