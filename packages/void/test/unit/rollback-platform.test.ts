import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockReadDeploymentPlatform = vi.fn();
const mockReadCloudflareWorkerStatus = vi.fn();
const mockActivateCloudflareExistingVersion = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  cancel: vi.fn(),
  confirm: vi.fn(async () => true),
  isCancel: () => false,
  log: { error: vi.fn(), info: vi.fn(), message: vi.fn(), warn: vi.fn() },
  outro: vi.fn(),
  select: vi.fn(),
}));
vi.mock('../../src/cli/project.ts', () => ({
  readDeploymentPlatform: mockReadDeploymentPlatform,
  readProjectConfig: () => null,
}));
vi.mock('../../src/cli/auth.ts', () => ({ getToken: () => null }));
vi.mock('../../src/cli/cloudflare-operations.ts', () => ({
  activateCloudflareExistingVersion: mockActivateCloudflareExistingVersion,
  readCloudflareWorkerStatus: mockReadCloudflareWorkerStatus,
  resolveCloudflareOperationContext: () => ({ workerName: 'app' }),
}));

const { log } = await import('@voidzero-dev/vite-plus-prompts');
const output = await import('../../src/cli/output.ts');
const { runRollbackCommand } = await import('../../src/cli/rollback.ts');

const metadata = (migrations: Array<string>) => ({
  schema: 2,
  migrations,
  triggerConfig: { preserve: false },
});

function messages(): string {
  return vi
    .mocked(log.message)
    .mock.calls.map(([message]) => String(message))
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
  vi.spyOn(output, 'createSpinner').mockReturnValue({ start: vi.fn(), stop: vi.fn() } as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
  mockReadCloudflareWorkerStatus.mockResolvedValue({
    workerName: 'app',
    activeVersionId: 'new-version',
    deployedVersionIds: ['old-version', 'new-version'],
    versions: [
      { id: 'old-version', metadata: metadata(['001_init.sql']) },
      { id: 'new-version', metadata: metadata(['001_init.sql', '002_add_email.sql']) },
    ],
  });
});

describe('void project rollback --platform cloudflare', () => {
  it('rolls back the Cloudflare Worker after a one-off deploy from a Void project', async () => {
    mockReadDeploymentPlatform.mockReturnValue('void');

    await runRollbackCommand('/app', 'old-version', 'cloudflare');

    expect(mockActivateCloudflareExistingVersion).toHaveBeenCalledWith(
      { workerName: 'app' },
      expect.objectContaining({ id: 'old-version' }),
      expect.objectContaining({ id: 'new-version' }),
    );
    // The bare restore command would follow the saved Void platform.
    expect(messages()).toContain('`void db restore --platform cloudflare --bookmark <bookmark>`');
    expect(output.printSuccess).toHaveBeenCalledWith('Rolled back to old-version.');
  });

  it('rolls back the Cloudflare Worker when deployment is disabled in the saved project', async () => {
    mockReadDeploymentPlatform.mockReturnValue('none');

    await runRollbackCommand('/app', 'old-version', 'cloudflare');

    expect(mockActivateCloudflareExistingVersion).toHaveBeenCalled();
  });

  it('keeps the bare restore command when Cloudflare is the saved platform', async () => {
    mockReadDeploymentPlatform.mockReturnValue('cloudflare');

    await runRollbackCommand('/app', 'old-version');

    expect(mockActivateCloudflareExistingVersion).toHaveBeenCalled();
    expect(messages()).toContain('`void db restore --bookmark <bookmark>`');
  });

  it('follows the saved Void platform without --platform', async () => {
    mockReadDeploymentPlatform.mockReturnValue('void');

    await expect(runRollbackCommand('/app', 'old-version')).rejects.toThrow('process.exit:1');

    expect(mockReadCloudflareWorkerStatus).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('Not logged in. Run `void account login` first.');
  });
});
