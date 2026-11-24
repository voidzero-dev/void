import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { captureOutput, setIsolatedHome } from '../helpers/cli-command.ts';

const tempHomes: Array<string> = [];
const mockGetToken = vi.fn<() => string | null>();

vi.mock('../../src/cli/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/auth.ts')>()),
  getToken: () => mockGetToken(),
}));

function createProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'void-project-'));
  tempHomes.push(dir);
  return dir;
}

async function importRunProjectsCommand() {
  vi.resetModules();
  const mod = await import('../../src/cli/projects.ts');
  return mod.runProjectsCommand;
}

describe('runProjectsCommand', () => {
  beforeEach(() => {
    mockGetToken.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    delete process.env.VOID_PLATFORM_REGISTRY_DIR;
    delete process.env.VOID_TOKEN;
    delete process.env.VOID_API_URL;

    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    while (tempHomes.length > 0) {
      const dir = tempHomes.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints projects for the authenticated user', async () => {
    tempHomes.push(setIsolatedHome());
    const root = createProjectRoot();
    mockGetToken.mockReturnValue('test-token');
    process.env.VOID_API_URL = 'https://api.example.test';

    const fetchMock = vi.fn(async () =>
      Response.json([
        {
          id: 'proj_1',
          user_id: 'user_1',
          slug: 'star-tracker',
          role: 'owner',
          created_at: '2026-02-15T00:00:00.000Z',
        },
        {
          id: 'proj_2',
          user_id: 'user_1',
          slug: 'todo-app',
          role: 'collaborator',
          created_at: '2026-02-15T00:00:00.000Z',
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const capture = captureOutput();
    const runProjectsCommand = await importRunProjectsCommand();
    await runProjectsCommand(root);
    const out = capture.output();
    capture.restore();

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/projects', {
      headers: {
        Authorization: 'Bearer test-token',
        'X-Void-CLI-Version': expect.stringMatching(/^\d+\.\d+\.\d+/),
      },
      redirect: 'manual',
    });
    expect(out).toContain('star-tracker');
    expect(out).toContain('owner');
    expect(out).toContain('https://star-tracker.apps.example.test');
    expect(out).toContain('todo-app');
    expect(out).toContain('collaborator');
    expect(out).toContain('https://todo-app.apps.example.test');
  });

  it('prints a friendly message when there are no projects', async () => {
    tempHomes.push(setIsolatedHome());
    const root = createProjectRoot();
    mockGetToken.mockReturnValue('test-token');
    process.env.VOID_API_URL = 'https://api.example.test';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    );

    const capture = captureOutput();
    const runProjectsCommand = await importRunProjectsCommand();
    await runProjectsCommand(root);
    const out = capture.output();
    capture.restore();

    expect(out).toContain('No projects found.');
  });

  it('exits with error when not logged in', async () => {
    tempHomes.push(setIsolatedHome());
    const root = createProjectRoot();

    const capture = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runProjectsCommand = await importRunProjectsCommand();
    await expect(runProjectsCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('Not logged in');
  });
});
