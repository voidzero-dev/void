import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformClient } from '../../src/cli/client.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';

const mockCancel = vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').cancel>();
const mockConfirm = vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').confirm>();
const mockGetToken = vi.fn<typeof import('../../src/cli/auth.ts').getToken>();
const mockListProjects = vi.fn<PlatformClient['listProjects']>();
const mockCreateProject = vi.fn<PlatformClient['createProject']>();
const mockText = vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').text>();
const mockOutro = vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').outro>();
const mockSelect = vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').select<string>>();

const existingProject = {
  id: 'proj_1',
  user_id: 'user_1',
  slug: 'existing-app',
  type: 'worker',
  created_at: '2026-05-27T00:00:00.000Z',
  custom_domain: null,
  role: 'owner' as const,
};

vi.mock('../../src/cli/interactive-prompts.ts', () => import('@voidzero-dev/vite-plus-prompts'));
vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  cancel: (...args: Parameters<typeof mockCancel>) => mockCancel(...args),
  confirm: (...args: Parameters<typeof mockConfirm>) => mockConfirm(...args),
  intro: vi.fn(),
  isCancel: (value: unknown) => value === Symbol.for('cancel'),
  log: { warn: vi.fn(), step: vi.fn() },
  outro: (...args: Parameters<typeof mockOutro>) => mockOutro(...args),
  select: (...args: Parameters<typeof mockSelect>) => mockSelect(...args),
  text: (...args: Parameters<typeof mockText>) => mockText(...args),
}));

vi.mock('../../src/cli/auth', () => ({
  getSiteDomain: () => 'void.app',
  getToken: (...args: Parameters<typeof mockGetToken>) => mockGetToken(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformApiError: class extends Error {},
  PlatformClient: class {
    readonly apiUrl = 'https://api.void.cloud';

    listProjects() {
      return mockListProjects();
    }
    createProject(...args: Parameters<PlatformClient['createProject']>) {
      return mockCreateProject(...args);
    }
  },
}));

// Disable colors so assertions can match plain strings without ANSI escape codes.
vi.mock('picocolors', () => {
  const id = (s: string) => s;
  return {
    default: {
      blue: id,
      bold: id,
      cyan: id,
      dim: id,
      gray: id,
      green: id,
      red: id,
      reset: id,
      white: id,
      yellow: id,
    },
  };
});

describe('runLink', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'void-link-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'viteconf-void' }));
    process.env.VOID_PLATFORM_REGISTRY_DIR = join(root, 'registry');
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://api.void.cloud',
      applicationDomain: 'void.app',
      displayName: 'Void Cloud',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.void.cloud',
    });
    mockCancel.mockReset();
    mockConfirm.mockReset();
    mockGetToken.mockReset();
    mockListProjects.mockReset();
    mockCreateProject.mockReset();
    mockText.mockReset();
    mockOutro.mockReset();
    mockSelect.mockReset();
  });

  afterEach(() => {
    delete process.env.VOID_PLATFORM_REGISTRY_DIR;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('confirms before interactively linking an existing project', async () => {
    const { runLink } = await import('../../src/cli/link.ts');
    mockGetToken.mockReturnValue('token_123');
    mockListProjects.mockResolvedValueOnce([existingProject]);
    mockSelect.mockResolvedValueOnce('proj_1');
    mockConfirm.mockResolvedValueOnce(true);

    await runLink(root);

    expect(mockConfirm).toHaveBeenCalledWith({
      message:
        'Linking to an existing project. Running `void deploy` will overwrite the current deployment of existing-app.void.app. Continue?',
    });
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8'))).toEqual({
      applicationDomain: 'void.app',
      platform: 'void',
      platformUrl: 'https://api.void.cloud',
      proxyUrl: 'https://proxy.void.cloud',
      projectId: 'proj_1',
      slug: 'existing-app',
    });
    expect(stripVTControlCharacters(String(mockOutro.mock.calls[0]?.[0]))).toBe(
      '\n✓ Linked to existing-app.void.app',
    );
  });

  it('does not write project config when the existing-project guard is declined', async () => {
    const { runLink } = await import('../../src/cli/link.ts');
    mockGetToken.mockReturnValue('token_123');
    mockListProjects.mockResolvedValueOnce([existingProject]);
    mockSelect.mockResolvedValueOnce('proj_1');
    mockConfirm.mockResolvedValueOnce(false);
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    });

    await expect(runLink(root)).rejects.toThrow('exit 0');

    expect(mockCancel).toHaveBeenCalledWith('Project link cancelled.');
    expect(existsSync(join(root, '.void', 'project.json'))).toBe(false);
  });

  it('finishes creating and linking a project with one separated checkmarked success', async () => {
    const { runLink } = await import('../../src/cli/link.ts');
    mockGetToken.mockReturnValue('token_123');
    mockListProjects.mockResolvedValue([]);
    mockSelect.mockResolvedValue('__create__');
    mockText.mockResolvedValue('viteconf-void');
    mockCreateProject.mockResolvedValue({ id: 'proj_new', slug: 'viteconf-void' });

    await runLink(root);

    expect(mockCreateProject).toHaveBeenCalledExactlyOnceWith('viteconf-void');
    expect(mockOutro).toHaveBeenCalledExactlyOnceWith(
      '\n✓ Created and linked to viteconf-void.void.app',
      { withGuide: false },
    );
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8')).projectId).toBe(
      'proj_new',
    );
  });

  it('uses the same success for non-interactive linking', async () => {
    const { runLink } = await import('../../src/cli/link.ts');
    mockGetToken.mockReturnValue('token_123');
    mockListProjects.mockResolvedValue([existingProject]);

    await runLink(root, 'existing-app');

    expect(mockOutro).toHaveBeenCalledExactlyOnceWith('\n✓ Linked to existing-app.void.app', {
      withGuide: false,
    });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('does not print a success when creating a project fails', async () => {
    const { runLink } = await import('../../src/cli/link.ts');
    mockGetToken.mockReturnValue('token_123');
    mockListProjects.mockResolvedValue([]);
    mockSelect.mockResolvedValue('__create__');
    mockText.mockResolvedValue('viteconf-void');
    mockCreateProject.mockRejectedValue(new Error('Connection lost'));

    await expect(runLink(root)).rejects.toThrow('Connection lost');
    expect(mockOutro).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.void', 'project.json'))).toBe(false);
  });
});
