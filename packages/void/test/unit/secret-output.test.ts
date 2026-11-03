import { stripVTControlCharacters } from 'node:util';
import { S_BAR } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { runSecretCommand } from '../../src/cli/secret.ts';

const mutations = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

vi.mock('../../src/cli/auth.ts', () => ({ getToken: () => 'fixture' }));
vi.mock('../../src/cli/client.ts', () => ({
  PlatformClient: class {
    setSecret = mutations.set;
    deleteSecret = mutations.delete;
    async listSecrets() {
      return [{ name: 'API_KEY' }];
    }
  },
}));
vi.mock('../../src/cli/project.ts', () => ({
  readDeploymentPlatform: () => 'void',
  readProjectConfig: () => ({ projectId: 'project' }),
}));
vi.mock('../../src/cli/env-validation.ts', () => ({ validateSecretValues: vi.fn() }));

it.each(['put', 'delete'] as const)(
  'prints one completion for secret %s without exposing its value',
  async (action) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    await runSecretCommand(
      '/fixture',
      action === 'put'
        ? { action, name: 'API_KEY', value: 'private-value' }
        : { action, name: 'API_KEY' },
    );
    expect(stripVTControlCharacters(output)).toContain(
      `\n✓ Secret API_KEY ${action === 'put' ? 'set' : 'deleted'}.\n\n`,
    );
    expect(output.match(/✓/g)).toHaveLength(1);
    expect(output).not.toContain('private-value');
  },
);

it('prints no success after a secret mutation fails', async () => {
  mutations.set.mockRejectedValueOnce(new Error('Permission denied'));
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  await expect(
    runSecretCommand('/fixture', { action: 'put', name: 'API_KEY', value: 'private-value' }),
  ).rejects.toThrow('Permission denied');
  expect(output).not.toContain('✓');
});

it('lists secrets when the terminal reports 0 columns', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 0 });
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    await runSecretCommand('/fixture', { action: 'list' });
    const text = stripVTControlCharacters(output);
    const contents = text
      .split('\n')
      .filter((line) => line.startsWith(S_BAR))
      .map((line) => line.slice(1, -1).trim())
      .join('');
    expect(contents).toContain('API_KEY');
    expect(text).toContain('1 secret');
  } finally {
    write.mockRestore();
    if (descriptor) {
      Object.defineProperty(process.stdout, 'columns', descriptor);
    } else {
      Reflect.deleteProperty(process.stdout, 'columns');
    }
  }
});
