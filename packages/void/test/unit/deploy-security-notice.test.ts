import { describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError } from '../../src/cli/client.ts';
import type { PlatformClient } from '../../src/cli/client.ts';
import { printDeploySecurityNotice } from '../../src/cli/deploy-security-notice.ts';
import type { ProjectSecurityStatus } from '../../src/cli/security-api-types.ts';
import { securityStatus as status } from '../helpers/security-status.ts';

const urgent = (n: number): ProjectSecurityStatus['urgent'] => ({
  count: n,
  counts: { critical: Math.min(n, 1), high: Math.max(0, n - 1) },
  oldestFirstSeenAt: '2026-11-01T00:00:00.000Z',
  more: 0,
  detail: 'full',
  findings: Array.from({ length: n }, (_, index) => ({
    id: `F-${index + 1}`,
    severity: index === 1 ? 'critical' : 'high',
    title: `Title ${index + 1}\u001b[31m red`,
    file: 'src/a.ts',
    line: 4,
  })),
});

async function run(reply: () => Promise<unknown>, env: NodeJS.ProcessEnv = {}) {
  const lines: Array<string> = [];
  await printDeploySecurityNotice({
    client: { getProjectSecurity: vi.fn(reply) } as unknown as PlatformClient,
    projectId: 'project_1',
    slug: 'acme-web',
    deploymentId: 'dpl_9a1d',
    env,
    write: (line) => lines.push(line),
  });
  return { lines };
}

describe('deploy security notice', () => {
  it('prints the queued scan and urgent rows for a user session, with ANSI stripped', async () => {
    const text = (await run(async () => status({ urgent: urgent(2) }))).lines.join('\n');
    expect(text).toContain('Security scan queued · model @cf/deepseek-ai/deepseek-v4.1-flash-1017');
    expect(text).toContain(
      '⚠ 2 urgent security findings are open in acme-web (1 critical, 1 high):',
    );
    expect(text).toContain('Title 2 red');
    expect(text).not.toContain('\u001b');
    expect(text).toContain('void project security show F-2');
  });

  it('drops to counts and ids in CI even when the server sent titles', async () => {
    const env = { CI: 'true' };
    const text = (await run(async () => status({ urgent: urgent(2) }), env)).lines.join('\n');
    expect(text).toContain('2 urgent security findings are open (1 critical, 1 high): F-2, F-1');
    expect(text).toContain('Details are not printed in CI logs.');
    expect(text).not.toContain('Title');
    expect(text).not.toContain('src/a.ts');
  });

  it.each([
    ['500', () => Promise.reject(new PlatformApiError('boom', 500, ''))],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('prints nothing and keeps the exit code on a %s', async (_name, reply) => {
    const before = process.exitCode;
    expect((await run(reply)).lines).toEqual([]);
    expect(process.exitCode).toBe(before);
  });
});
