import { stripVTControlCharacters } from 'node:util';

export type PlatformErrorPayload = {
  error?: string;
  message?: string;
  deployment?: string;
  minVersion?: string;
  clientVersion?: string;
};

export type ProjectPermission = 'read' | 'configure' | 'deploy' | 'settings' | 'members' | 'owner';

export function parsePlatformErrorBody(body: string): PlatformErrorPayload | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const result: PlatformErrorPayload = {};
    for (const key of ['error', 'message', 'deployment', 'minVersion', 'clientVersion'] as const) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return null;
  }
}

function plainExplanation(value: string | undefined): string | undefined {
  const text = value
    ? stripVTControlCharacters(value)
        // Keep line breaks and tabs, but not control characters that rewrite the terminal.
        // eslint-disable-next-line no-control-regex
        .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
        .trim()
    : undefined;
  // Error fields should contain an explanation, not another serialized response
  // or an upstream login/error page. Keep the original body on PlatformApiError.
  return text && !text.startsWith('{') && !text.startsWith('[') && !/<[^>]+>/.test(text)
    ? text
    : undefined;
}

export function platformErrorMessage(payload: PlatformErrorPayload | null): string | undefined {
  const message = plainExplanation(payload?.message);
  return message &&
    !/^(forbidden|unauthorized|access denied|permission denied)[.!]?$/i.test(message)
    ? message
    : undefined;
}

function unexplainedRejection(status: number): string {
  if (status === 401) {
    return 'Authentication was rejected. Check the credentials for the selected platform and any access gateway in front of it.';
  }
  if (status === 403) {
    return 'Access was denied by the platform or its access gateway. Check the selected platform and ask its administrator to confirm your access.';
  }
  return 'The platform did not provide an explanation. Retry the operation; if it still fails, contact the platform administrator.';
}

function permissionMessage(permission?: ProjectPermission): string {
  if (permission === 'owner') {
    return 'Only the project owner can perform this action. Ask the owner to run it using their platform login.';
  }
  if (permission === 'read') {
    return 'This action requires project membership (reader or higher). Ask a project admin or owner for access.';
  }
  if (permission === 'settings' || permission === 'members') {
    return 'This action requires admin or owner access. Ask a project admin or owner to confirm your access.';
  }
  if (permission === 'configure' || permission === 'deploy') {
    return 'This action requires collaborator, admin, or owner access. Ask a project admin or owner to confirm your access.';
  }
  return 'Ask the platform administrator to check your access to this action.';
}

const rejectionMessages: Record<string, string> = {
  'invalid or expired token':
    'The platform reported an invalid or expired token. Sign in again with `void connect <platform-url>`, or replace `VOID_TOKEN` if you supplied it.',
  'missing authorization header':
    'A platform login or token is required. Sign in with `void connect <platform-url>`, or supply a valid `VOID_TOKEN` for that platform.',
  'session revoked; sign in again':
    'Your platform session was revoked. Sign in again with `void connect <platform-url>`, or replace `VOID_TOKEN` if you supplied it.',
  'user not found':
    'This account is no longer available. Contact the platform administrator or sign in with an active account on this platform.',
  'deploy credential revoked or expired':
    'This project deploy credential was revoked or expired. Ask the project owner to issue a replacement and update the credential used by your automation.',
  'deploy token build is no longer active':
    'This build is no longer active. Start a new build to obtain a valid deployment credential.',
  github_identity_required:
    'Link your GitHub account with `void github link`, then retry this operation.',
  connect_authorization_required:
    'This GitHub repository requires authorization. Run `void github connect` in an interactive terminal to authorize access, then retry.',
  'invalid connect grant':
    'GitHub authorization failed or expired. Run `void github connect` again.',
  'installation access revoked':
    'Access to this GitHub installation was revoked. Ask its administrator to restore access, then run `void github join`.',
  'account suspended':
    'This account is suspended. Contact the platform administrator to restore access.',
  'project owner suspended':
    'The project owner is suspended. Ask the owner to contact the platform administrator.',
  'project is being deleted':
    'This project is being deleted. Wait for deletion to finish before creating a replacement.',
  'registered user not found':
    'No registered account matches that email address. Ask the recipient to sign in to this platform first, then invite their registered email.',
  'the project owner cannot be invited or changed as a member':
    'The project owner cannot be invited or changed through team membership commands. Choose another member.',
  'the project owner cannot leave the project':
    'The project owner cannot leave. Ask a platform administrator to transfer ownership first.',
  'user is already a project member':
    'This user is already a project member. Use `void project team list` to find their user ID, then `void project team role` to change their role.',
  'project member not found':
    'This user is no longer a project member. Run `void project team list` to check current members.',
  'project has too many pending invitations':
    'This project has reached its pending invitation limit. Run `void project team invitations` and revoke invitations that are no longer needed.',
};

export function formatPlatformApiError(
  action: string,
  status: number,
  body: string,
  permission?: ProjectPermission,
): string {
  const parsed = parsePlatformErrorBody(body);
  const message = platformErrorMessage(parsed);
  if (status === 426 && parsed?.error === 'cli_outdated' && message) {
    return message;
  }
  if (!parsed) {
    if (status === 401 || status === 403) {
      const plain = plainExplanation(body);
      const explanation =
        plain && !/^(forbidden|unauthorized|access denied|permission denied)[.!]?$/i.test(plain)
          ? plain.replaceAll(/\s+/g, ' ').slice(0, 240)
          : unexplainedRejection(status);
      return `${action} (HTTP ${status}): ${explanation}`;
    }
    // Keep the raw status and body of other opaque provider failures for diagnostics.
    return `${action}: ${status} ${body}`;
  }
  const detail =
    message ??
    (status === 403 && parsed.error === 'forbidden'
      ? `Access denied. ${permissionMessage(permission)}`
      : ((parsed.error && Object.hasOwn(rejectionMessages, parsed.error)
          ? rejectionMessages[parsed.error]
          : undefined) ??
        (status === 401 && ['unauthorized', 'missing token'].includes(parsed.error ?? '')
          ? rejectionMessages['invalid or expired token']
          : plainExplanation(parsed.error))));
  return `${action} (HTTP ${status}): ${detail || unexplainedRejection(status)}`;
}
