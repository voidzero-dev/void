import type { Mock } from 'vite-plus/test';
import { vi } from 'vite-plus/test';
import type { CloudflareCommandResult } from '../src/execute.ts';
import type { CloudflareOperation } from '../src/operations.ts';

/** Run an argv-style test callback behind the typed operation runner. */
export function operationFixture<
  T extends (
    args: Array<string>,
    options: { capture: boolean; input?: string; env?: Record<string, string> },
  ) => CloudflareCommandResult | Promise<CloudflareCommandResult>,
>(
  callback: T,
): Mock<T> &
  ((
    operation: CloudflareOperation,
    options?: unknown,
  ) => CloudflareCommandResult | Promise<CloudflareCommandResult>) {
  const mock = vi.fn(callback);
  const runner = ((operation: CloudflareOperation, ...rest: Array<unknown>) => {
    const result = Reflect.apply(mock, undefined, [
      operation === undefined
        ? []
        : Array.isArray(operation)
          ? operation
          : operationFixtureArgs(operation),
      ...rest,
    ]) as CloudflareCommandResult | Promise<CloudflareCommandResult>;
    const decode = (value: CloudflareCommandResult) => {
      const decoded = operationFixtureResult(value);
      if (
        !Array.isArray(operation) &&
        operation?.type === 'queues.info' &&
        value.status !== 0 &&
        value.stderr.includes(`Queue "${operation.name}" does not exist.`)
      ) {
        return { ...decoded, failure: 'not-found' as const };
      }
      if (
        !Array.isArray(operation) &&
        (operation?.type === 'email.routing.settings' ||
          operation?.type === 'email.sending.settings') &&
        value.status !== 0 &&
        /Could not find zone for|No sending subdomain found/.test(value.stderr)
      ) {
        return { ...decoded, status: 0, data: null };
      }
      return decoded;
    };
    return result instanceof Promise ? result.then(decode) : decode(result);
  }) as Mock<T> &
    ((
      operation: CloudflareOperation,
      options?: unknown,
    ) => CloudflareCommandResult | Promise<CloudflareCommandResult>);
  Object.defineProperty(runner, 'mock', { get: () => mock.mock });
  Object.defineProperty(runner, '_isMockFunction', { value: true });
  for (const key of [
    'getMockName',
    'mockClear',
    'mockReset',
    'mockRestore',
    'mockImplementation',
    'mockImplementationOnce',
    'mockReturnValue',
    'mockReturnValueOnce',
    'mockResolvedValue',
    'mockResolvedValueOnce',
    'mockRejectedValue',
    'mockRejectedValueOnce',
  ] as const) {
    Object.defineProperty(runner, key, {
      value: (...args: Array<unknown>) => {
        const value: unknown = Reflect.apply(mock[key], mock, args);
        return value === mock ? runner : value;
      },
    });
  }
  return runner;
}

export function operationFixtureResult(result: CloudflareCommandResult): CloudflareCommandResult {
  let data = result.data;
  if (data === undefined) {
    try {
      data = JSON.parse(result.stdout);
    } catch {
      /* Human diagnostic fixture. */
    }
    const versionId = result.stdout.match(/(?:Worker|Current) Version ID:\s*([0-9a-f-]+)/i)?.[1];
    if (versionId) {
      data = {
        versionId,
        previewUrl: result.stdout.match(/Version Preview(?: Alias)? URL:\s*(https:\/\/\S+)/i)?.[1],
        workersDevUrl: result.stdout.match(
          /(https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[^\s]*)?)/i,
        )?.[1],
      };
    }
    const queueName = result.stdout.match(/^Queue Name:\s*(\S+)/m)?.[1];
    if (queueName) {
      // `Consumers: a, b` lists the consumer Workers; `-` is a non-Worker consumer.
      const consumers =
        result.stdout
          .split('\n')
          .find((line) => line.startsWith('Consumers:'))
          ?.slice('Consumers:'.length) ?? '';
      data = {
        name: queueName,
        consumers: consumers
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name) => (name === '-' ? null : name)),
      };
    }
    if (result.stdout.includes('No migrations to apply!')) {
      data = { pending: [] };
    }
    if (result.stdout.includes('Migrations to be applied:')) {
      data = { pending: ['fixture-pending.sql'] };
    }
  }
  const output = result.stdout + '\n' + result.stderr;
  const errorCode =
    result.errorCode ?? (Number(output.match(/\[code:\s*(\d+)\]/)?.[1]) || undefined);
  const failure =
    result.failure ??
    (result.status !== 0 &&
    /pending\s+Durable\s+Object\s+migration|Durable Object migrations require deploy/i.test(output)
      ? 'durable-migration'
      : result.status !== 0 &&
          /no deployments|Worker.*does not exist|Worker.*not found|cannot upload a new version of a worker that does not yet exist/i.test(
            output,
          )
        ? 'not-found'
        : undefined);
  return {
    ...result,
    data,
    errorCode,
    failure,
    errors: result.errors ?? (result.status !== 0 ? [{ message: output }] : undefined),
  };
}

export function operationFixtureArgs(operation: CloudflareOperation): Array<string> {
  const config = operation.configPath ? ['-c', operation.configPath] : [];
  const target = [
    ...config,
    '--env=',
    ...('workerName' in operation && operation.workerName ? ['--name', operation.workerName] : []),
  ];
  switch (operation.type) {
    case 'auth.whoami':
      return ['whoami', '--json', ...config, '--env='];
    case 'auth.login':
      return ['login'];
    case 'auth.logout':
      return ['logout'];
    case 'auth.token':
      return ['auth', 'token', '--json', ...config, ...(config.length ? ['--env='] : [])];
    case 'deployments.status':
      return ['deployments', 'status', ...target, '--json'];
    case 'deployments.list':
      return ['deployments', 'list', ...target, '--json'];
    case 'versions.list':
      return ['versions', 'list', ...target, '--json'];
    case 'versions.view':
      return ['versions', 'view', operation.versionId, ...target, '--json'];
    case 'versions.deploy':
      return [
        'versions',
        'deploy',
        ...operation.versions.map(({ versionId, percentage }) => `${versionId}@${percentage}`),
        ...target,
        ...(operation.message ? ['--message', operation.message] : []),
        '--yes',
      ];
    case 'versions.upload':
    case 'worker.deploy':
      return [
        ...(operation.type === 'versions.upload' ? ['versions', 'upload'] : ['deploy']),
        ...target,
        ...(operation.message ? ['--message', operation.message] : []),
        ...(operation.secretsFilePath ? ['--secrets-file', operation.secretsFilePath] : []),
        ...(operation.assetsDirectory ? ['--assets', operation.assetsDirectory] : []),
        ...(operation.previewAlias ? ['--preview-alias', operation.previewAlias] : []),
        ...(operation.type === 'versions.upload' || operation.message !== undefined
          ? ['--strict']
          : []),
        '--experimental-provision=false',
        '--experimental-auto-create=false',
        ...(operation.type === 'worker.deploy' ? ['--autoconfig=false'] : []),
      ];
    case 'triggers.deploy':
      return ['triggers', 'deploy', ...target];
    case 'queues.consumer.remove':
      return [
        'queues',
        'consumer',
        'remove',
        operation.queueName,
        operation.workerName,
        ...config,
        '--env=',
      ];
    case 'queues.info':
    case 'queues.create':
      return [
        'queues',
        operation.type === 'queues.info' ? 'info' : 'create',
        operation.name,
        ...config,
        '--env=',
      ];
    case 'd1.list':
      return ['d1', 'list', '--json', ...config, '--env='];
    case 'd1.info':
      return ['d1', 'info', operation.name, '--json', ...config, '--env='];
    case 'd1.create':
      return [
        'd1',
        'create',
        operation.name,
        '--binding',
        operation.binding,
        '--update-config',
        ...config,
        '--env=',
      ];
    case 'kv.namespace.list':
      return ['kv', 'namespace', 'list', ...config, '--env='];
    case 'kv.namespace.create':
      return [
        'kv',
        'namespace',
        'create',
        operation.name,
        '--binding',
        operation.binding,
        '--update-config',
        ...config,
        '--env=',
      ];
    case 'r2.bucket.info':
      return ['r2', 'bucket', 'info', operation.name, '--json', ...config, '--env='];
    case 'r2.bucket.create':
      return [
        'r2',
        'bucket',
        'create',
        operation.name,
        '--binding',
        operation.binding,
        '--update-config',
        ...config,
        '--env=',
      ];
    case 'hyperdrive.create':
      return [
        'hyperdrive',
        'create',
        operation.name,
        '--binding',
        operation.binding,
        '--update-config',
        ...config,
        '--env=',
      ];
    case 'd1.migrations.list':
    case 'd1.migrations.apply':
      return [
        'd1',
        'migrations',
        operation.type === 'd1.migrations.list' ? 'list' : 'apply',
        operation.database,
        '--remote',
        ...config,
        '--env=',
      ];
    case 'd1.time-travel.bookmark':
      return ['d1', 'time-travel', 'info', operation.database, '--json', ...config, '--env='];
    case 'containers.list':
      return ['containers', 'list', '--json', ...config, '--env='];
    case 'secret.list':
      return ['secret', 'list', '--format=json', ...target];
    case 'secret.put':
    case 'secret.delete':
      return [
        'secret',
        operation.type === 'secret.put' ? 'put' : 'delete',
        operation.name,
        ...target,
      ];
    case 'secret.bulk':
      return ['secret', 'bulk', ...target];
    case 'email.routing.settings':
      return ['email', 'routing', 'settings', operation.domain, ...config, '--env='];
    case 'email.routing.rules.list':
      return ['email', 'routing', 'rules', 'list', operation.domain, ...config, '--env='];
    case 'email.routing.enable':
      return ['email', 'routing', 'enable', operation.domain, ...config, '--env='];
    case 'email.sending.settings':
      return ['email', 'sending', 'settings', operation.domain, ...config, '--env='];
    case 'email.sending.enable':
      return ['email', 'sending', 'enable', operation.domain, ...config, '--env='];
    default:
      throw new Error(`Fixture has no argument shape for ${operation.type}.`);
  }
}

export function operationFixtureRequest(args: Array<string>): CloudflareOperation {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const target = { configPath: value('-c'), workerName: value('--name') };
  if (args[0] === 'd1' && args[1] === 'list') {
    return { type: 'd1.list', configPath: value('-c') };
  }
  if (args[0] === 'noop' || args[0] === 'noop-late') {
    return { type: 'd1.list' };
  }
  if (args[0] === 'whoami') {
    return { type: 'auth.whoami', configPath: value('-c') };
  }
  if (args[0] === 'login') {
    return { type: 'auth.login' };
  }
  if (args[0] === 'auth') {
    return { type: 'auth.token', configPath: value('-c') };
  }
  if (args[0] === 'secret') {
    if (args[1] === 'list') {
      return { type: 'secret.list', ...target };
    }
    if (args[1] === 'put') {
      return { type: 'secret.put', name: args[2]!, ...target };
    }
  }
  if (args[0] === 'd1' && args[1] === 'migrations') {
    return {
      type: args[2] === 'apply' ? 'd1.migrations.apply' : 'd1.migrations.list',
      database: args[3]!,
      configPath: value('-c')!,
    };
  }
  if (args[0] === 'd1' && args[1] === 'time-travel') {
    return { type: 'd1.time-travel.bookmark', database: args[3]!, configPath: value('-c')! };
  }
  if (args[0] === 'queues' && args[1] === 'info') {
    return { type: 'queues.info', name: args[2]!, configPath: value('-c') };
  }
  if (args[0] === 'containers') {
    return { type: 'containers.list', configPath: value('-c') };
  }
  if (args[0] === 'deployments') {
    return { type: args[1] === 'status' ? 'deployments.status' : 'deployments.list', ...target };
  }
  if (args[0] === 'versions') {
    if (args[1] === 'list') {
      return { type: 'versions.list', ...target };
    }
    if (args[1] === 'view') {
      return { type: 'versions.view', versionId: args[2]!, ...target };
    }
    if (args[1] === 'upload') {
      return {
        type: 'versions.upload',
        ...target,
        message: value('--message'),
        secretsFilePath: value('--secrets-file'),
        assetsDirectory: value('--assets'),
        previewAlias: value('--preview-alias'),
      };
    }
    if (args[1] === 'deploy') {
      return {
        type: 'versions.deploy',
        ...target,
        message: value('--message'),
        versions: args
          .slice(2)
          .filter((value) => /^[^@]+@\d+(?:\.\d+)?$/.test(value))
          .map((value) => {
            const [versionId, percentage] = value.split('@');
            return { versionId: versionId!, percentage: Number(percentage) };
          }),
      };
    }
  }
  if (args[0] === 'deploy') {
    return {
      type: 'worker.deploy',
      ...target,
      message: value('--message'),
      secretsFilePath: value('--secrets-file'),
      assetsDirectory: value('--assets'),
    };
  }
  if (args[0] === 'triggers') {
    return { type: 'triggers.deploy', ...target };
  }
  if (args[0] === 'queues' && args[1] === 'consumer') {
    return {
      type: 'queues.consumer.remove',
      queueName: args[3]!,
      workerName: args[4]!,
      configPath: value('-c'),
    };
  }
  throw new Error(`Fixture has no typed request for ${args.slice(0, 2).join(' ')}.`);
}
