import { createHash } from 'node:crypto';
import type { PlatformInstallationManifest } from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';
import { PlatformCloudflareApiError } from '../../src/cli/platform-cloudflare.ts';
import {
  deletePlatformSecurityScanner,
  securityScannerNames,
} from '../../src/cli/platform-security-audits.ts';

const ID = 'inst-test';
const SUFFIX = createHash('sha256')
  .update(`void-security-scanner:${ID}`)
  .digest('hex')
  .slice(0, 12);
const ACCOUNT = '/accounts/acct';
const MARKER = JSON.stringify({ protocol: 1, installation: ID });
const manifest = {
  id: ID,
  account: { id: 'acct' },
  deployment: { capabilities: { securityAudits: true }, resources: { dispatchNamespace: 'users' } },
} as unknown as PlatformInstallationManifest;
const owner = (text: string) => ({
  bindings: [{ type: 'plain_text', name: '__VOID_SECURITY_SCANNER_OWNER', text }],
});

/** Answers GETs from `reads` (else `missing(path)`, 404 by default); records the rest. */
function fakeClient(reads: Record<string, unknown>, missing = (_path: string) => 404) {
  const calls: Array<string> = [];
  const client = {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        calls.push(`${method} ${path}`);
        return {} as T;
      }
      if (path in reads) {
        return reads[path] as T;
      }
      throw new PlatformCloudflareApiError('missing', missing(path), path);
    },
  };
  return { client, calls };
}

describe('security scanner uninstall', () => {
  const names = securityScannerNames(ID);
  const sandbox = `${ACCOUNT}/workers/scripts/void-security-copy-sandbox-${SUFFIX}`;
  const namespace = `${ACCOUNT}/workers/dispatch/namespaces/void-security-copies-${SUFFIX}`;
  const prefix = `void-sec-copy-${SUFFIX}-`;

  it('derives the copy names the API creates', () => {
    expect([names.copyNamespace, names.copySandbox, names.copyPrefix]).toEqual([
      `void-security-copies-${SUFFIX}`,
      `void-security-copy-sandbox-${SUFFIX}`,
      prefix,
    ]);
  });

  it('removes the copy namespace, leftover copy stores and the sandbox after the controller', async () => {
    const controller = `${ACCOUNT}/workers/scripts/${names.worker}`;
    const { client, calls } = fakeClient({
      [`${controller}/settings`]: owner(MARKER),
      [`${sandbox}/settings`]: owner(MARKER),
      [namespace]: { namespace_name: names.copyNamespace },
      [`${ACCOUNT}/d1/database?name=${encodeURIComponent(prefix)}&per_page=100&page=1`]: [
        { uuid: 'd1-copy', name: `${prefix}scan1-a1-d0` },
        { uuid: 'd1-app', name: 'app-db' },
      ],
      [`${ACCOUNT}/storage/kv/namespaces?per_page=100&page=1`]: [
        { id: 'kv-copy', title: `${prefix}scan1-a1-k0` },
      ],
      [`${ACCOUNT}/r2/buckets?name_contains=${encodeURIComponent(prefix)}&per_page=1000`]: {
        buckets: [{ name: `${prefix}scan1-a1-r0` }],
      },
      ...Object.fromEntries(
        [
          names.application,
          names.engines['engine-a'].application,
          names.engines['engine-c'].application,
        ].map((name) => [
          `${ACCOUNT}/containers/applications?name=${encodeURIComponent(name)}`,
          [],
        ]),
      ),
    });

    const result = await deletePlatformSecurityScanner(client, manifest, async () => {
      throw new Error('no registry call expected');
    });

    expect(result).toEqual({ deleted: ['controller', 'runtime copies'], kept: [] });
    expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual([
      `DELETE ${controller}`,
      `DELETE ${namespace}`,
      `DELETE ${ACCOUNT}/d1/database/d1-copy`,
      `DELETE ${ACCOUNT}/storage/kv/namespaces/kv-copy`,
      `DELETE ${ACCOUNT}/r2/buckets/${prefix}scan1-a1-r0`,
      `DELETE ${sandbox}`,
    ]);
  });

  it('keeps a copy sandbox another installation owns, and its namespace', async () => {
    const { client, calls } = fakeClient({
      [`${sandbox}/settings`]: owner('{"protocol":1,"installation":"other"}'),
      [namespace]: {},
    });

    const result = await deletePlatformSecurityScanner(client, manifest);

    expect(result.kept).toEqual([`security copy sandbox ${names.copySandbox}`]);
    expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual([]);
  });

  it('treats a token without Containers or storage rights as nothing to remove when the scanner was never created', async () => {
    const denied = ['/containers/', '/d1/', '/storage/', '/r2/'];
    const { client, calls } = fakeClient({}, (path) =>
      denied.some((part) => path.includes(part)) ? 403 : 404,
    );

    await expect(deletePlatformSecurityScanner(client, manifest)).resolves.toEqual({
      deleted: [],
      kept: [],
    });
    expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual([]);
  });
});
