/**
 * GitHub Actions OIDC → Void deploy-token exchange for `void deploy` without `VOID_TOKEN`.
 *
 * Server contract (platform `POST /auth/github-oidc` handler):
 *   request  { oidcToken: string, project: string }   (project = slug)
 *   response { token: string, projectId, buildId }
 */

import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken } from './cf-access.ts';

const OIDC_AUDIENCE = 'void';

export function isGithubActionsOidcAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.GITHUB_ACTIONS === 'true' &&
    typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === 'string' &&
    env.ACTIONS_ID_TOKEN_REQUEST_URL.length > 0 &&
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' &&
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0
  );
}

export async function exchangeGithubOidcForDeployToken(
  apiUrl: string,
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      'github-oidc: GitHub Actions OIDC is unavailable (missing ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN). Ensure the workflow grants `permissions: id-token: write`.',
    );
  }

  const oidcToken = await requestGithubOidcToken(requestUrl, requestToken);
  return exchangeOidcTokenAtApi(apiUrl, project, oidcToken);
}

/** GitHub's request URL already has a query string, so `audience` is added to it. */
async function requestGithubOidcToken(requestUrl: string, requestToken: string): Promise<string> {
  const url = new URL(requestUrl);
  url.searchParams.set('audience', OIDC_AUDIENCE);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${requestToken}` },
      redirect: 'manual',
    });
  } catch (err) {
    // oxlint-disable-next-line preserve-caught-error -- The message includes the sanitized provider error text.
    throw new Error(`github-oidc: Failed to reach the GitHub OIDC token endpoint: ${errText(err)}`);
  }

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(
      `github-oidc: Failed to mint a GitHub OIDC token (${res.status})${body ? `: ${body}` : ''}.`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('github-oidc: GitHub OIDC token endpoint returned an invalid response.');
  }

  const value = (body as { value?: unknown } | null)?.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('github-oidc: GitHub OIDC token endpoint did not return a token value.');
  }

  return value;
}

/** POST the OIDC JWT to the Void API and return the minted deploy token. */
async function exchangeOidcTokenAtApi(
  apiUrl: string,
  project: string,
  oidcToken: string,
): Promise<string> {
  const url = `${apiUrl}/auth/github-oidc`;
  ensurePlatformAccessToken(apiUrl);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfAccessHeaders(process.env, apiUrl) },
      body: JSON.stringify({ oidcToken, project }),
      redirect: 'manual',
    });
  } catch (err) {
    // oxlint-disable-next-line preserve-caught-error -- The message includes the sanitized provider error text.
    throw new Error(`github-oidc: Failed to reach ${url}: ${errText(err)}`);
  }

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(
      `github-oidc: OIDC token exchange failed (${res.status})${body ? `: ${body}` : ''}. Confirm the repository is connected to project "${project}" with the github_actions executor.`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('github-oidc: OIDC token exchange returned an invalid response.');
  }

  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('github-oidc: OIDC token exchange did not return a deploy token.');
  }

  return token;
}

/** Redact `value` from GitHub Actions logs; GitHub reads workflow commands from stdout. */
export function maskGithubActionsSecret(value: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_ACTIONS !== 'true' || !value) {
    return;
  }
  process.stdout.write(`::add-mask::${value}\n`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}
