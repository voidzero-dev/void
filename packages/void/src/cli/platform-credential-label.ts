/**
 * Names a Cloudflare credential and where it came from, so an error can say
 * which credential Cloudflare rejected and how to fix it.
 */
export type PlatformCredentialLabel = Readonly<{
  /** `management` is the operator credential; `runtime` is the token the platform Workers use. */
  role: 'management' | 'runtime';
  /** Unknown when a caller does not say. */
  source?: 'environment' | 'saved' | 'oauth' | 'entered';
  /** The variable that held an `environment` credential. */
  environmentVariable?: string;
  /**
   * Set on the runtime token when Void uses it for AI Gateway in place of
   * this operator credential.
   */
  aiGatewayFor?: PlatformCredentialLabel;
}>;

export type PlatformCredentialDenial = Readonly<{
  permission: string;
  status: number;
  /** The request, such as `GET /accounts/…/queues`, when it helps. */
  request?: string;
}>;

export const PLATFORM_RUNTIME_TOKEN_VARIABLE = 'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN';
export const PLATFORM_AI_GATEWAY_PERMISSION = 'Account → AI Gateway → Edit';

/** For example `management token from CLOUDFLARE_API_TOKEN`. */
export function describePlatformCredential(label: PlatformCredentialLabel): string {
  if (label.source === 'oauth') {
    return 'Cloudflare browser login (Wrangler OAuth)';
  }
  const kind = credentialKind(label);
  switch (label.source) {
    case 'environment':
      return `${kind} from ${fixVariable(label)}`;
    case 'saved':
      return `${kind} saved on this machine`;
    case 'entered':
      return `${kind} you entered`;
    default:
      return kind;
  }
}

/**
 * What to tell the operator after Cloudflare answered 401 or 403 to one
 * request made with this credential.
 */
export function platformCredentialHelp(
  label: PlatformCredentialLabel,
  status: number,
  requestPath: string | undefined,
): string {
  const permission = requestPath ? cloudflarePermissionForPath(requestPath) : undefined;
  if (label.aiGatewayFor) {
    return `${aiGatewayStandIn(label)} ${credentialAdvice(label, status, permission ? [permission] : [])}`;
  }
  if (label.source === 'oauth' && permission === PLATFORM_AI_GATEWAY_PERMISSION) {
    return browserLoginAiGatewayHelp();
  }
  return `Void used the ${describePlatformCredential(label)}. ${credentialAdvice(label, status, permission ? [permission] : [])}`;
}

/**
 * One message for every check Cloudflare denied to one credential: the list
 * of missing permissions, then what to do.
 */
export function formatPlatformCredentialDenials(
  label: PlatformCredentialLabel,
  denials: ReadonlyArray<PlatformCredentialDenial>,
): string {
  // Several checks can share one permission, status and request; list it once.
  const lines = [
    ...new Set(
      denials.map(
        (denial) =>
          `- ${denial.permission} (HTTP ${denial.status}${denial.request ? `; ${denial.request}` : ''})`,
      ),
    ),
  ];
  const help: Array<string> = [];
  if (label.aiGatewayFor) {
    help.push(aiGatewayStandIn(label));
  }
  // Browser login never has AI Gateway access, whatever Cloudflare answered.
  const rest =
    label.source === 'oauth'
      ? denials.filter((denial) => denial.permission !== PLATFORM_AI_GATEWAY_PERMISSION)
      : denials;
  if (rest.length < denials.length) {
    help.push(browserLoginAiGatewayHelp());
  }
  if (rest.some((denial) => denial.status === 401)) {
    help.push(credentialAdvice(label, 401, []));
  }
  const forbidden = [
    ...new Set(rest.filter((denial) => denial.status !== 401).map((denial) => denial.permission)),
  ];
  if (forbidden.length > 0) {
    help.push(credentialAdvice(label, 403, forbidden));
  }
  return `Cloudflare denied the ${describePlatformCredential(label)}:\n${lines.join('\n')}\n${help.join(' ')}`;
}

/** The Cloudflare permission a request path needs, when Void knows it. */
export function cloudflarePermissionForPath(requestPath: string): string | undefined {
  const parts = requestPath.split('?')[0]!.split('/').filter(Boolean);
  if (parts[0] === 'accounts') {
    if (parts.length === 1) {
      return 'Account → Account Settings → Read';
    }
    const area = parts[2];
    if (area === 'ai-gateway') {
      return PLATFORM_AI_GATEWAY_PERMISSION;
    }
    if (area === 'storage' && parts[3] === 'kv') {
      return 'Account → Workers KV Storage → Edit';
    }
    if (area === 'r2') {
      return 'Account → Workers R2 Storage → Edit';
    }
    if (area === 'queues') {
      return 'Account → Queues → Edit';
    }
    if (area === 'hyperdrive') {
      return 'Account → Hyperdrive → Edit';
    }
    if (area === 'workers') {
      return 'Account → Workers Scripts → Edit';
    }
    if (area === 'email' && parts[3] === 'routing') {
      return 'Account → Email Routing Addresses → Edit';
    }
    return undefined;
  }
  if (parts[0] === 'zones') {
    if (parts.length <= 2) {
      return 'Zone → Zone → Read';
    }
    const area = parts[2];
    if (area === 'workers' && parts[3] === 'routes') {
      return 'Zone → Workers Routes → Edit';
    }
    if (area === 'dns_records') {
      return 'Zone → DNS → Edit';
    }
    if (area === 'purge_cache') {
      return 'Zone → Cache Purge → Purge';
    }
    if (area === 'custom_hostnames') {
      return 'Zone → SSL and Certificates → Edit';
    }
    if (area === 'email' && parts[3] === 'routing') {
      return parts[4] === 'rules'
        ? 'Zone → Email Routing Rules → Edit'
        : 'Zone → Zone Settings → Edit';
    }
  }
  return undefined;
}

function credentialKind(label: PlatformCredentialLabel): string {
  return label.role === 'runtime' ? 'runtime token' : 'management token';
}

/** The variable that replaces this credential. */
function fixVariable(label: PlatformCredentialLabel): string {
  if (label.role === 'runtime') {
    return PLATFORM_RUNTIME_TOKEN_VARIABLE;
  }
  return (label.source === 'environment' && label.environmentVariable) || 'CLOUDFLARE_API_TOKEN';
}

function credentialAdvice(
  label: PlatformCredentialLabel,
  status: number,
  permissions: ReadonlyArray<string>,
): string {
  const variable = fixVariable(label);
  const kind = credentialKind(label);
  if (status === 401) {
    return label.source === 'oauth'
      ? 'HTTP 401 means the browser login is no longer valid. Run `void cloudflare login` again, or set CLOUDFLARE_API_TOKEN to a management token for this account, then retry.'
      : `HTTP 401 means Cloudflare did not accept the token: it is not valid, has expired, or was replaced. Set ${variable} to a valid ${kind}, then retry.`;
  }
  const missing =
    permissions.length > 1
      ? 'the permissions listed above'
      : (permissions[0] ?? 'a permission this request needs');
  const them = permissions.length > 1 ? 'them' : 'it';
  return label.source === 'oauth'
    ? `HTTP 403 means browser login does not grant ${missing}. Set CLOUDFLARE_API_TOKEN to a management token with ${them} for this account, then retry.`
    : `HTTP 403 means the token works but is missing ${missing}, or is not scoped to this account or zone. Add ${them} to the token in the Cloudflare dashboard (the token value stays the same), or set ${variable} to a ${kind} that has ${them}, then retry.`;
}

function aiGatewayStandIn(label: PlatformCredentialLabel): string {
  const name = describePlatformCredential(label);
  return label.aiGatewayFor?.source === 'oauth'
    ? `Browser login cannot use AI Gateway, so Void used the ${name} for it. Fix the runtime token, not the management token.`
    : `Void used the ${name} for AI Gateway. Fix the runtime token.`;
}

function browserLoginAiGatewayHelp(): string {
  return `Browser login cannot use AI Gateway. Set ${PLATFORM_RUNTIME_TOKEN_VARIABLE} to the platform runtime token, or set CLOUDFLARE_API_TOKEN to a management token with ${PLATFORM_AI_GATEWAY_PERMISSION}, then retry.`;
}
