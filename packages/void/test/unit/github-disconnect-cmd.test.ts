import { confirm, log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError } from '../../src/cli/client.ts';
import type { PlatformClient } from '../../src/cli/client.ts';
import { runGithubDisconnect } from '../../src/cli/github-cmd.ts';
import * as output from '../../src/cli/output.ts';
import { makeConnection, makeProject, projectId, slug } from '../helpers/github-cli.ts';

// `vi.spyOn(clack, 'confirm')` cannot intercept the handler's named `confirm`
// import under this project's ESM Vitest config ("Module namespace is not
// configurable in ESM"). Mock the module instead, keeping every other export
// real (log/cancel/isCancel/select/text) so only `confirm` is replaced with a
// drivable spy. `vi.mock` is hoisted above the imports above.
vi.mock('@voidzero-dev/vite-plus-prompts', async (imp) => ({
  ...(await imp<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  confirm: vi.fn(),
}));

type FakeClient = Pick<
  PlatformClient,
  'listProjects' | 'getGithubConnection' | 'deleteGithubConnection'
>;

function makeClient(over: Partial<FakeClient> = {}): {
  client: PlatformClient;
  getGithubConnection: ReturnType<typeof vi.fn>;
  deleteGithubConnection: ReturnType<typeof vi.fn>;
} {
  const listProjects = vi.fn(async () => [makeProject()]);
  const getGithubConnection = vi.fn(async () => makeConnection());
  const deleteGithubConnection = vi.fn(async () => ({ ok: true }));
  const client = {
    listProjects,
    getGithubConnection,
    deleteGithubConnection,
    ...over,
  } as unknown as PlatformClient;
  return {
    client,
    getGithubConnection:
      (over.getGithubConnection as ReturnType<typeof vi.fn>) ?? getGithubConnection,
    deleteGithubConnection:
      (over.deleteGithubConnection as ReturnType<typeof vi.fn>) ?? deleteGithubConnection,
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let successSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  // The mocked `confirm` is a persistent vi.fn() from the module factory;
  // vi.restoreAllMocks() does not reset its call history, so clear it per-test
  // to keep the `toHaveBeenCalledTimes(1)` assertion honest.
  vi.mocked(confirm).mockReset();
  originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  successSpy = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  vi.restoreAllMocks();
});

describe('runGithubDisconnect', () => {
  it('disconnects with --yes in a non-interactive shell', async () => {
    const { client, deleteGithubConnection } = makeClient();

    await runGithubDisconnect('/project', client, {
      subcommand: 'disconnect',
      projectName: slug,
      yes: true,
    });

    expect(deleteGithubConnection).toHaveBeenCalledWith(projectId);
    expect(successSpy).toHaveBeenCalledWith('Disconnected octocat/hello-world.');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('refuses without --yes in a non-interactive shell (exit 1, no delete)', async () => {
    const { client, deleteGithubConnection } = makeClient();

    await expect(
      runGithubDisconnect('/project', client, { subcommand: 'disconnect', projectName: slug }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(deleteGithubConnection).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'disconnect: Refusing to disconnect without confirmation in a non-interactive shell. Re-run with --yes.',
    );
  });

  it('reports success and does not delete when the project is not connected', async () => {
    const notConnected = new PlatformApiError(
      'Failed to get GitHub connection',
      404,
      JSON.stringify({ error: 'connection not found' }),
    );
    const { client, deleteGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () => {
        throw notConnected;
      }),
    });

    await runGithubDisconnect('/project', client, {
      subcommand: 'disconnect',
      projectName: slug,
      yes: true,
    });

    expect(deleteGithubConnection).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      'This project is not connected to a GitHub repository. Nothing to disconnect.',
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('maps a 403 on read to a no-access message (exit 1)', async () => {
    const forbidden = new PlatformApiError(
      'Failed to get GitHub connection',
      403,
      JSON.stringify({ error: 'forbidden' }),
      'read',
    );
    const { client, deleteGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () => {
        throw forbidden;
      }),
    });

    await expect(
      runGithubDisconnect('/project', client, {
        subcommand: 'disconnect',
        projectName: slug,
        yes: true,
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('project membership (reader or higher)'),
    );
    expect(deleteGithubConnection).not.toHaveBeenCalled();
  });

  it('preserves the server explanation for a GitHub read rejection', async () => {
    const rejection = new PlatformApiError(
      'Failed to get GitHub connection',
      403,
      JSON.stringify({
        error: 'forbidden',
        message: 'This credential cannot read GitHub settings. Use your platform login.',
      }),
      'read',
    );
    const { client, deleteGithubConnection } = makeClient({
      getGithubConnection: vi.fn(async () => {
        throw rejection;
      }),
    });
    await expect(
      runGithubDisconnect('/project', client, {
        subcommand: 'disconnect',
        projectName: slug,
        yes: true,
      }),
    ).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Use your platform login.'));
    expect(deleteGithubConnection).not.toHaveBeenCalled();
  });

  it('prompts to confirm in a TTY and aborts when declined', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(confirm).mockResolvedValue(false as never);
    const { client, deleteGithubConnection } = makeClient();

    await runGithubDisconnect('/project', client, {
      subcommand: 'disconnect',
      projectName: slug,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteGithubConnection).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('Disconnect cancelled.');
  });

  it('prompts to confirm in a TTY and disconnects when accepted', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(confirm).mockResolvedValue(true as never);
    const { client, deleteGithubConnection } = makeClient();

    await runGithubDisconnect('/project', client, {
      subcommand: 'disconnect',
      projectName: slug,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteGithubConnection).toHaveBeenCalledWith(projectId);
    expect(successSpy).toHaveBeenCalledWith('Disconnected octocat/hello-world.');
  });
});
