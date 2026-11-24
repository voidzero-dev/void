vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: () => null,
  writeKeyringPassword: () => true,
}));
const accessJwt =
  'header.' +
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') +
  '.signature';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { MockInstance } from 'vite-plus/test';
import {
  exchangeGithubOidcForDeployToken,
  isGithubActionsOidcAvailable,
  maskGithubActionsSecret,
} from '../../src/cli/github-oidc.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REQUEST_URL = 'https://token.actions.githubusercontent.com/abc?api-version=2.0';
const REQUEST_TOKEN = 'req-token-123';

function oidcEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: 'true',
    ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

describe('isGithubActionsOidcAvailable', () => {
  it('is true when GITHUB_ACTIONS=true and both request vars are non-empty', () => {
    expect(isGithubActionsOidcAvailable(oidcEnv())).toBe(true);
  });

  it('is false when GITHUB_ACTIONS is not exactly "true"', () => {
    expect(isGithubActionsOidcAvailable(oidcEnv({ GITHUB_ACTIONS: 'false' }))).toBe(false);
    expect(isGithubActionsOidcAvailable(oidcEnv({ GITHUB_ACTIONS: undefined }))).toBe(false);
  });

  it('is false when the request URL is missing or empty', () => {
    expect(isGithubActionsOidcAvailable(oidcEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: undefined }))).toBe(
      false,
    );
    expect(isGithubActionsOidcAvailable(oidcEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: '' }))).toBe(false);
  });

  it('is false when the request token is missing or empty', () => {
    expect(
      isGithubActionsOidcAvailable(oidcEnv({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined })),
    ).toBe(false);
    expect(isGithubActionsOidcAvailable(oidcEnv({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }))).toBe(
      false,
    );
  });
});

describe('exchangeGithubOidcForDeployToken', () => {
  const apiUrl = 'https://api.test';

  it('mints an OIDC token then exchanges it for a deploy token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'oidc-jwt' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'deploy-token', projectId: 'p1' }));

    const token = await exchangeGithubOidcForDeployToken(apiUrl, 'my-app', oidcEnv());
    expect(token).toBe('deploy-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 1. GET the OIDC token with audience=void appended and the request bearer.
    const [getUrl, getInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(getUrl)).toContain('audience=void');
    expect(String(getUrl)).toContain('token.actions.githubusercontent.com');
    expect(getInit.method ?? 'GET').toBe('GET');
    expect(getInit.redirect).toBe('manual');
    expect((getInit.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${REQUEST_TOKEN}`,
    );

    // 2. POST the JWT to the Void API; body is exactly { oidcToken, project }.
    const [postUrl, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe(`${apiUrl}/auth/github-oidc`);
    expect(postInit.method).toBe('POST');
    expect(postInit.redirect).toBe('manual');
    expect((postInit.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(postInit.body).toBe(JSON.stringify({ oidcToken: 'oidc-jwt', project: 'my-app' }));
  });

  it('forwards CF Access service-token headers on the API POST but not the GitHub GET', async () => {
    const gatedApiUrl = 'https://api.staging.void.cloud';
    vi.stubEnv('VOID_ACCESS_ORIGIN', gatedApiUrl);
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'cf-id');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'cf-secret');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'oidc-jwt' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'deploy-token' }));

    await exchangeGithubOidcForDeployToken(gatedApiUrl, 'my-app', oidcEnv());

    // The GitHub OIDC GET goes to token.actions.githubusercontent.com, never through CF Access.
    const [, getInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const getHeaders = getInit.headers as Record<string, string>;
    expect(getHeaders['CF-Access-Client-Id']).toBeUndefined();
    expect(getHeaders['CF-Access-Client-Secret']).toBeUndefined();

    const [, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const postHeaders = postInit.headers as Record<string, string>;
    expect(postHeaders['CF-Access-Client-Id']).toBe('cf-id');
    expect(postHeaders['CF-Access-Client-Secret']).toBe('cf-secret');
  });

  it('forwards a CF_ACCESS_TOKEN user JWT on the API POST but not the GitHub GET', async () => {
    const gatedApiUrl = 'https://api.staging.void.cloud';
    vi.stubEnv('VOID_ACCESS_ORIGIN', gatedApiUrl);
    vi.stubEnv('CF_ACCESS_TOKEN', accessJwt);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'oidc-jwt' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'deploy-token' }));

    await exchangeGithubOidcForDeployToken(gatedApiUrl, 'my-app', oidcEnv());

    const [, getInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((getInit.headers as Record<string, string>)['cf-access-token']).toBeUndefined();

    const [, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((postInit.headers as Record<string, string>)['cf-access-token']).toBe(accessJwt);
  });

  it('never forwards shared Access credentials to a self-hosted API', async () => {
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'cf-id');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'cf-secret');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'oidc-jwt' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'deploy-token' }));

    await exchangeGithubOidcForDeployToken(apiUrl, 'my-app', oidcEnv());

    const [, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const postHeaders = postInit.headers as Record<string, string>;
    expect(postHeaders['CF-Access-Client-Id']).toBeUndefined();
    expect(postHeaders['CF-Access-Client-Secret']).toBeUndefined();
  });

  it('throws before any fetch when the request vars are absent', async () => {
    await expect(
      exchangeGithubOidcForDeployToken(
        apiUrl,
        'my-app',
        oidcEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: undefined }),
      ),
    ).rejects.toThrow(/id-token: write/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with status + body when minting the OIDC token fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }));
    await expect(exchangeGithubOidcForDeployToken(apiUrl, 'my-app', oidcEnv())).rejects.toThrow(
      /Failed to mint a GitHub OIDC token \(403\): nope/,
    );
    // The second hop must not run once the first fails.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the OIDC endpoint omits a token value', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ notValue: 'x' }));
    await expect(exchangeGithubOidcForDeployToken(apiUrl, 'my-app', oidcEnv())).rejects.toThrow(
      /did not return a token value/,
    );
  });

  it('throws with status + body when the API exchange fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'oidc-jwt' }))
      .mockResolvedValueOnce(new Response('project does not match connection', { status: 401 }));

    await expect(exchangeGithubOidcForDeployToken(apiUrl, 'my-app', oidcEnv())).rejects.toThrow(
      /OIDC token exchange failed \(401\): project does not match connection/,
    );
  });

  it('throws when the API omits the deploy token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'oidc-jwt' }))
      .mockResolvedValueOnce(jsonResponse({ projectId: 'p1' }));

    await expect(exchangeGithubOidcForDeployToken(apiUrl, 'my-app', oidcEnv())).rejects.toThrow(
      /did not return a deploy token/,
    );
  });
});

describe('maskGithubActionsSecret', () => {
  let writeSpy: MockInstance;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('emits an ::add-mask:: workflow command inside GitHub Actions', () => {
    maskGithubActionsSecret('secret-token', { GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv);
    expect(writeSpy).toHaveBeenCalledWith('::add-mask::secret-token\n');
  });

  it('is a no-op when not running in GitHub Actions', () => {
    maskGithubActionsSecret('secret-token', {} as NodeJS.ProcessEnv);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty value', () => {
    maskGithubActionsSecret('', { GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
