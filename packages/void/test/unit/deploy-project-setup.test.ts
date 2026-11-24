import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformClient } from '../../src/cli/client.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';

const mockSelect = vi.fn();
const mockText = vi.fn();
const mockConfirm = vi.fn();
const mockStep = vi.fn();
const mockSuccess = vi.fn();
const mockWarn = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  cancel: vi.fn(),
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  intro: vi.fn(),
  isCancel: () => false,
  isCI: () => false,
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: (...args: Array<unknown>) => mockStep(...args),
    success: (...args: Array<unknown>) => mockSuccess(...args),
    warn: (...args: Array<unknown>) => mockWarn(...args),
  },
  note: vi.fn(),
  outro: vi.fn(),
  select: (...args: Array<unknown>) => mockSelect(...args),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  text: (...args: Array<unknown>) => mockText(...args),
}));

function createClient() {
  return {
    apiUrl: 'https://api.void.cloud',
    createProject: vi.fn(),
    listProjectChoices: vi.fn(),
  } as unknown as PlatformClient & {
    createProject: ReturnType<typeof vi.fn>;
    listProjectChoices: ReturnType<typeof vi.fn>;
  };
}

describe('promptDeployProjectConfig', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'void-deploy-project-'));
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
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test-app' }));
    mockSelect.mockReset();
    mockText.mockReset();
    mockConfirm.mockReset();
    mockStep.mockReset();
    mockSuccess.mockReset();
    mockWarn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.VOID_PLATFORM_REGISTRY_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['create', 'link'])(
    'keeps the saved destination when choosing to %s a temporary deployment project',
    async (action) => {
      const { promptDeployProjectConfig } = await import('../../src/cli/deploy-helpers.ts');
      const client = createClient();
      vi.stubEnv('VOID_API_URL', client.apiUrl);
      const projectFile = join(root, '.void/project.json');
      mkdirSync(join(root, '.void'));
      const original = JSON.stringify({
        platform: 'void',
        platformUrl: 'https://original.example.com',
        projectId: 'original',
        slug: 'original',
      });
      writeFileSync(projectFile, original);
      client.listProjectChoices.mockResolvedValue([{ id: 'proj_new', slug: 'new-app' }]);
      client.createProject.mockResolvedValue({ id: 'proj_new', slug: 'new-app' });
      mockSelect.mockResolvedValueOnce(action).mockResolvedValueOnce('proj_new');
      mockText.mockResolvedValue('new-app');
      mockConfirm.mockResolvedValue(true);
      expect(await promptDeployProjectConfig(root, client)).toEqual({
        projectId: 'proj_new',
        slug: 'new-app',
      });
      expect(readFileSync(projectFile, 'utf8')).toBe(original);
      expect(mockSelect.mock.calls[0]?.[0].options).toContainEqual({
        value: 'link',
        label: 'Use an existing project',
      });
      if (action === 'link') {
        expect(mockConfirm).toHaveBeenCalledWith({
          message:
            'This deployment will overwrite the current deployment of new-app.void.app. Continue?',
        });
        expect(mockStep).toHaveBeenCalledWith(
          expect.stringContaining('Saved destination unchanged.'),
        );
      }
    },
  );

  it('does not show link option when there are no existing projects', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy-helpers.ts');
    const client = createClient();
    client.listProjectChoices.mockResolvedValueOnce([]);
    client.createProject.mockResolvedValueOnce({ id: 'proj_new', slug: 'new-app' });
    mockSelect.mockResolvedValueOnce('create');
    mockText.mockResolvedValueOnce('new-app');

    const config = await promptDeployProjectConfig(root, client);

    expect(client.listProjectChoices).toHaveBeenCalledOnce();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledWith({
      message: 'Set up a Void project for deploy:',
      options: [{ value: 'create', label: 'Create a new project' }],
    });
    expect(client.createProject).toHaveBeenCalledWith('new-app');
    expect(config).toEqual({ projectId: 'proj_new', slug: 'new-app' });
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8'))).toEqual({
      applicationDomain: 'void.app',
      platform: 'void',
      platformUrl: 'https://api.void.cloud',
      proxyUrl: 'https://proxy.void.cloud',
      ...config,
    });
  });

  it('accepts short slugs at the prompt and lets the server enforce plan limits', async () => {
    const { promptProjectSlug } = await import('../../src/cli/prompt.ts');
    mockText.mockResolvedValueOnce('valid-app');

    await expect(promptProjectSlug('demo-app')).resolves.toBe('valid-app');

    const promptConfig = mockText.mock.calls[0]?.[0] as {
      validate: (value: string) => string | undefined;
    };
    expect(promptConfig).toMatchObject({ placeholder: 'demo-app', defaultValue: 'demo-app' });
    expect(promptConfig).not.toHaveProperty('initialValue');
    // Short slugs no longer rejected client-side — plan is checked server-side.
    expect(promptConfig.validate('abc')).toBeUndefined();
    expect(promptConfig.validate('abcde')).toBeUndefined();
    expect(promptConfig.validate('abcdef')).toBeUndefined();
    // Format check still runs locally.
    expect(promptConfig.validate('ABC')).toBe('Slug must be lowercase alphanumeric with dashes.');
    expect(promptConfig.validate('')).toBeUndefined();
    expect(promptConfig.validate(' ')).toBe('Project slug is required.');
  });

  it('does not retry on non-slug 403 errors (e.g. account suspended)', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy-helpers.ts');
    const { PlatformApiError } = await import('../../src/cli/client.ts');
    const client = createClient();
    client.listProjectChoices.mockResolvedValueOnce([]);
    client.createProject.mockRejectedValueOnce(
      new PlatformApiError('createProject', 403, JSON.stringify({ error: 'account suspended' })),
    );
    mockSelect.mockResolvedValueOnce('create');
    mockText.mockResolvedValueOnce('my-app');

    await expect(promptDeployProjectConfig(root, client)).rejects.toThrow(PlatformApiError);

    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(mockText).toHaveBeenCalledTimes(1);
  });

  it('only shows project names after the user chooses to link', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy-helpers.ts');
    const client = createClient();
    client.listProjectChoices.mockResolvedValueOnce([
      {
        id: 'proj_1',
        user_id: 'user_1',
        slug: 'existing-app',
        type: 'worker',
        created_at: '2026-04-24T00:00:00.000Z',
        custom_domain: null,
      },
    ]);
    mockSelect.mockResolvedValueOnce('link').mockResolvedValueOnce('proj_1');
    mockConfirm.mockResolvedValueOnce(true);

    const config = await promptDeployProjectConfig(root, client);

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(mockSelect.mock.calls[0]?.[0]).toMatchObject({
      message: 'Set up a Void project for deploy:',
      options: [
        { value: 'create', label: 'Create a new project' },
        { value: 'link', label: 'Link an existing project' },
      ],
    });
    expect(JSON.stringify(mockSelect.mock.calls[0]?.[0])).not.toContain('existing-app');
    expect(mockSelect.mock.calls[1]?.[0]).toMatchObject({
      message: 'Select a project to deploy to:',
      options: [
        {
          label: 'existing-app (existing-app.void.app)',
          value: 'proj_1',
        },
      ],
    });
    expect(mockConfirm).toHaveBeenCalledWith({
      message:
        'Linking to an existing project. Running `void deploy` will overwrite the current deployment of existing-app.void.app. Continue?',
    });
    expect(config).toEqual({ projectId: 'proj_1', slug: 'existing-app' });
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it('hides reader projects and identifies roles when selecting a deployment destination', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy-helpers.ts');
    const client = createClient();
    client.listProjectChoices.mockResolvedValueOnce([
      { id: 'proj_reader', slug: 'read-only-app', role: 'reader' },
      { id: 'proj_collaborator', slug: 'shared-app', role: 'collaborator' },
      { id: 'proj_admin', slug: 'admin-app', role: 'admin' },
      { id: 'proj_owner', slug: 'owned-app', role: 'owner' },
      { id: 'proj_legacy', slug: 'legacy-app' },
    ]);
    mockSelect.mockResolvedValueOnce('link').mockResolvedValueOnce('proj_collaborator');
    mockConfirm.mockResolvedValueOnce(true);

    const config = await promptDeployProjectConfig(root, client);

    expect(mockSelect.mock.calls[1]?.[0]).toEqual({
      message: 'Select a project to deploy to:',
      options: [
        {
          value: 'proj_collaborator',
          label: 'shared-app (shared-app.void.app)',
          hint: 'collaborator',
        },
        { value: 'proj_admin', label: 'admin-app (admin-app.void.app)', hint: 'admin' },
        { value: 'proj_owner', label: 'owned-app (owned-app.void.app)', hint: 'owner' },
        { value: 'proj_legacy', label: 'legacy-app (legacy-app.void.app)' },
      ],
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Projects with reader access are hidden from deploy selection.'),
    );
    expect(config).toEqual({ projectId: 'proj_collaborator', slug: 'shared-app' });
  });

  it('offers project creation without an empty link picker when every project is read-only', async () => {
    const { promptDeployProjectConfig } = await import('../../src/cli/deploy-helpers.ts');
    const client = createClient();
    client.listProjectChoices.mockResolvedValueOnce([
      { id: 'proj_reader', slug: 'read-only-app', role: 'reader' },
    ]);
    client.createProject.mockResolvedValueOnce({ id: 'proj_new', slug: 'new-app' });
    mockSelect.mockResolvedValueOnce('create');
    mockText.mockResolvedValueOnce('new-app');

    const config = await promptDeployProjectConfig(root, client);

    expect(mockSelect).toHaveBeenCalledOnce();
    expect(mockSelect).toHaveBeenCalledWith({
      message: 'Set up a Void project for deploy:',
      options: [{ value: 'create', label: 'Create a new project' }],
    });
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('grant collaborator access'));
    expect(config).toEqual({ projectId: 'proj_new', slug: 'new-app' });
  });

  it('keeps reader projects linkable and describes read-only access in the shared picker', async () => {
    const { promptProjectSelection } = await import('../../src/cli/prompt.ts');
    const project = {
      id: 'proj_reader',
      user_id: 'user_owner',
      slug: 'read-only-app',
      type: 'worker',
      created_at: '2026-04-24T00:00:00.000Z',
      custom_domain: null,
      role: 'reader' as const,
    };
    mockSelect.mockResolvedValueOnce(project.id);
    mockConfirm.mockResolvedValueOnce(true);

    await expect(
      promptProjectSelection([project], 'Select a project:', root, { confirmExisting: true }),
    ).resolves.toEqual({ action: 'select', project });

    expect(mockSelect).toHaveBeenCalledWith({
      message: 'Select a project:',
      options: [
        { value: '__create__', label: 'Create new project' },
        {
          value: 'proj_reader',
          label: 'read-only-app (read-only-app.void.app)',
          hint: 'reader (read-only)',
        },
      ],
    });
    expect(mockConfirm).toHaveBeenCalledWith({
      message:
        'Link to read-only-app with read-only access? Deploying requires collaborator access or higher.',
    });
  });
});
