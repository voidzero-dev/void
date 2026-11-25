import { deleteKeyringPassword, readKeyringPassword, writeKeyringPassword } from './keyring.ts';
import { OperatorClient, OperatorClientError } from './operator-client.ts';
import {
  getActivePlatformConnection,
  findPlatformConnections,
  normalizePlatformApiUrl,
  platformCredentialAccount,
} from './platform-registry.ts';

export const OPERATOR_KEYRING_SERVICE = 'dev.void.cli.operator';

/** Operator authority never comes from repository-controlled metadata. */
export function resolveOperatorOrigin(connection = ''): string {
  if (connection) {
    const matches = findPlatformConnections(connection);
    if (matches.length !== 1) {
      throw new OperatorClientError(
        'Select a registered platform slug or URL. Run `void connect <url> --no-login` to register it first.',
        'invalid_connection',
      );
    }
    return matches[0].apiUrl;
  }
  if (process.env.VOID_API_URL) {
    return normalizePlatformApiUrl(process.env.VOID_API_URL);
  }
  if (process.env.VOID_OPERATOR_TOKEN) {
    throw new OperatorClientError(
      'VOID_OPERATOR_TOKEN requires an explicit --connection or VOID_API_URL to select its recipient.',
      'explicit_origin_required',
    );
  }
  const active = getActivePlatformConnection();
  if (!active) {
    throw new OperatorClientError(
      'No default platform connection. Run `void connect <url>` or specify --connection.',
      'connection_required',
    );
  }
  return active.apiUrl;
}

export function readOperatorToken(origin: string): string {
  const token =
    process.env.VOID_OPERATOR_TOKEN ||
    readKeyringPassword(OPERATOR_KEYRING_SERVICE, platformCredentialAccount(origin));
  if (!token) {
    throw new OperatorClientError(
      'No operator session. Run `void platform auth login` or set VOID_OPERATOR_TOKEN with an explicit origin.',
      'authentication_required',
    );
  }
  return token;
}

export function saveOperatorToken(origin: string, token: string): void {
  if (!writeKeyringPassword(OPERATOR_KEYRING_SERVICE, platformCredentialAccount(origin), token)) {
    throw new OperatorClientError(
      'The system keychain is unavailable. Use `void platform auth token --token-stdin` with a full API session to obtain a token for VOID_OPERATOR_TOKEN; plaintext credential storage is disabled.',
      'keychain_unavailable',
    );
  }
}

export function removeOperatorToken(origin: string): void {
  const account = platformCredentialAccount(origin);
  if (
    readKeyringPassword(OPERATOR_KEYRING_SERVICE, account) &&
    !deleteKeyringPassword(OPERATOR_KEYRING_SERVICE, account)
  ) {
    throw new OperatorClientError(
      'The operator session was revoked, but its local keychain entry could not be removed.',
      'keychain_unavailable',
    );
  }
}

export async function readOperatorApiTokenStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new OperatorClientError(
      '--token-stdin requires an API session token piped on standard input.',
      'invalid_token_input',
    );
  }
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 32_768) {
      throw new OperatorClientError('API session token input is too large.', 'invalid_token_input');
    }
  }
  const token = input.trim();
  if (!token || token.length > 32_768 || /\s/.test(token)) {
    throw new OperatorClientError(
      'Standard input must contain one API session token.',
      'invalid_token_input',
    );
  }
  return token;
}

export async function exchangeOperatorSession(
  origin: string,
  apiToken: string,
): Promise<Record<string, unknown> & { token: string }> {
  const session = await new OperatorClient(origin, apiToken).request('/session', {
    method: 'POST',
    body: {},
  });
  if (
    typeof session.token !== 'string' ||
    !session.token ||
    session.apiVersion !== 1 ||
    typeof session.expiresAt !== 'string'
  ) {
    throw new OperatorClientError('Operator API returned an invalid session.', 'invalid_response');
  }
  return session as Record<string, unknown> & { token: string };
}
