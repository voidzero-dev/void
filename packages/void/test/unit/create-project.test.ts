import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformClient } from '../../src/cli/client.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';

const mockText = vi.fn();
const mockInfo = vi.fn();
const mockError = vi.fn();
const mockWarn = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  cancel: vi.fn(),
  isCancel: () => false,
  log: {
    error: (...args: Array<unknown>) => mockError(...args),
    info: (...args: Array<unknown>) => mockInfo(...args),
    step: vi.fn(),
    success: vi.fn(),
    warn: (...args: Array<unknown>) => mockWarn(...args),
  },
  text: (...args: Array<unknown>) => mockText(...args),
}));

function createClient() {
  return {
    // `promptAndCreateProject` records the platform identity behind the client's
    // API URL, verified by an explicit connection.
    apiUrl: 'https://api.void.cloud',
    createProject: vi.fn(),
  } as unknown as PlatformClient & {
    createProject: ReturnType<typeof vi.fn>;
  };
}

describe('promptAndCreateProject', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'void-create-project-'));
    process.env.VOID_PLATFORM_REGISTRY_DIR = join(root, 'registry');
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://api.void.cloud',
      applicationDomain: 'void.app',
      displayName: 'Test platform',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.void.cloud',
    });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test-app' }));
    mockText.mockReset();
    mockInfo.mockReset();
    mockError.mockReset();
    mockWarn.mockReset();
  });

  afterEach(() => {
    delete process.env.VOID_PLATFORM_REGISTRY_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  // The platform registers the owner's own address as a recipient AFTER it
  // has answered, so the create response names the address and nothing else.
  // The CLI must explain the verification email that may follow without
  // claiming to know whether one was sent.
  it('explains the owner recipient registration when the response names one', async () => {
    const { promptAndCreateProject } = await import('../../src/cli/create-project.ts');
    const client = createClient();
    client.createProject.mockResolvedValueOnce({
      id: 'proj_new',
      slug: 'new-app',
      owner_email_destination: { address: 'owner@example.com' },
    });
    mockText.mockResolvedValueOnce('new-app');

    const config = await promptAndCreateProject(root, client);

    expect(config).toEqual({ projectId: 'proj_new', slug: 'new-app' });
    expect(mockInfo).toHaveBeenCalledTimes(1);
    const message = mockInfo.mock.calls[0]?.[0] as string;
    expect(message).toContain('owner@example.com');
    // True in every outcome: neither "already verified" nor "check your
    // inbox" is asserted, and the user is pointed at where the state shows.
    expect(message).toContain('unless it is already verified');
    expect(message).toContain('void email destinations');
    expect(message).not.toMatch(/is already verified as a sender/);
    expect(message).not.toMatch(/check your inbox/);
  });

  it('prints nothing about email when the response carries no owner recipient', async () => {
    const { promptAndCreateProject } = await import('../../src/cli/create-project.ts');
    const client = createClient();
    client.createProject.mockResolvedValueOnce({ id: 'proj_new', slug: 'new-app' });
    mockText.mockResolvedValueOnce('new-app');

    const config = await promptAndCreateProject(root, client);

    expect(config).toEqual({ projectId: 'proj_new', slug: 'new-app' });
    expect(mockInfo).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf8'))).toEqual({
      platform: 'void',
      ...config,
      // The platform identity behind the client's API URL, recorded on every new link.
      applicationDomain: 'void.app',
      platformUrl: 'https://api.void.cloud',
      proxyUrl: 'https://proxy.void.cloud',
    });
  });

  it('keeps actionable rejection guidance when prompting for a replacement slug', async () => {
    const { promptAndCreateProject } = await import('../../src/cli/create-project.ts');
    const { PlatformApiError } = await import('../../src/cli/client.ts');
    const client = createClient();
    client.createProject
      .mockRejectedValueOnce(
        new PlatformApiError(
          'Failed to create project',
          403,
          JSON.stringify({
            error: 'forbidden',
            message: 'Short slugs require a paid plan. Choose a name with at least six characters.',
          }),
        ),
      )
      .mockResolvedValueOnce({ id: 'proj_new', slug: 'longer-app' });
    mockText.mockResolvedValueOnce('short').mockResolvedValueOnce('longer-app');

    await promptAndCreateProject(root, client);

    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('Choose a name with at least six characters.'),
    );
    expect(mockError.mock.calls[0]?.[0]).not.toContain('{');
    expect(client.createProject).toHaveBeenNthCalledWith(2, 'longer-app');
  });

  it('surfaces every project creation warning without terminal control characters', async () => {
    const { promptAndCreateProject } = await import('../../src/cli/create-project.ts');
    const client = createClient();
    client.createProject.mockResolvedValueOnce({
      id: 'proj_new',
      slug: 'new-app',
      warnings: [
        'Project created, but its Zero Trust protection could not be initialized.',
        'Retry\u001b[31m before deployment.',
      ],
    });
    mockText.mockResolvedValueOnce('new-app');

    await promptAndCreateProject(root, client);

    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(mockWarn).toHaveBeenNthCalledWith(
      1,
      'Project created, but its Zero Trust protection could not be initialized.',
    );
    expect(mockWarn).toHaveBeenNthCalledWith(2, 'Retry [31m before deployment.');
  });

  // The platform caps slugs at 56 characters (the `<slug>+noreply@` sender
  // has to fit RFC 5321's 64-octet local-part) and answers 400. Like every
  // other validation 400, that must re-prompt rather than abort the deploy.
  it('re-prompts when the server rejects a slug over 56 characters', async () => {
    const { promptAndCreateProject } = await import('../../src/cli/create-project.ts');
    const { PlatformApiError } = await import('../../src/cli/client.ts');
    const client = createClient();
    const tooLong = `len-${'a'.repeat(53)}`;
    client.createProject
      .mockRejectedValueOnce(
        new PlatformApiError(
          'createProject',
          400,
          JSON.stringify({ error: 'slug must be at most 56 characters' }),
        ),
      )
      .mockResolvedValueOnce({ id: 'proj_new', slug: 'shorter-app' });
    mockText.mockResolvedValueOnce(tooLong).mockResolvedValueOnce('shorter-app');

    const config = await promptAndCreateProject(root, client);

    expect(client.createProject).toHaveBeenNthCalledWith(1, tooLong);
    expect(client.createProject).toHaveBeenNthCalledWith(2, 'shorter-app');
    expect(mockText).toHaveBeenCalledTimes(2);
    // Enter must still validate a suggested slug rejected on the previous attempt.
    const secondPrompt = mockText.mock.calls[1]?.[0] as {
      defaultValue: string;
      validate: (value: string) => string | undefined;
    };
    expect(secondPrompt.defaultValue).toBe(tooLong);
    expect(secondPrompt.validate('')).toContain('Slug must be at most 56 characters');
    expect(secondPrompt.validate('shorter-app')).toBeUndefined();
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('slug must be at most 56 characters'),
    );
    expect(config).toEqual({ projectId: 'proj_new', slug: 'shorter-app' });
  });
});

describe('validateProjectSlug', () => {
  it('refuses a slug over 56 characters before the round trip, and accepts one at the cap', async () => {
    const { MAX_SLUG_LENGTH, validateProjectSlug } = await import('../../src/cli/project-slug.ts');
    expect(MAX_SLUG_LENGTH).toBe(56);
    expect(validateProjectSlug('a'.repeat(56))).toBeUndefined();
    expect(validateProjectSlug('a'.repeat(57))).toBe(
      'Slug must be at most 56 characters (it forms the email sender <slug>+noreply@).',
    );
  });
});
