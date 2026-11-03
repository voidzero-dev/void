import { describe, expect, it } from 'vite-plus/test';
import { parsePlatformRuntimeManifest, platformDatabaseSchemaDigest } from '../../src/installer.ts';
import {
  createPlatformDeploymentManifest,
  parsePlatformDeploymentManifest,
  type PlatformDeploymentManifestInput,
} from '../../src/manifest.ts';
import { deploymentInput, workerConfigs } from '../worker-config-fixture.ts';

const workersDevInput: PlatformDeploymentManifestInput = {
  application: {
    baseDomain: 'team.workers.dev',
    zoneName: '',
    workersDev: { subdomain: 'team', installationId: 'team-12345678' },
  },
  displayName: 'Team',
  installationSlug: 'team',
};
const configurableInput: PlatformDeploymentManifestInput = {
  ...deploymentInput,
  authentication: { providers: ['oidc'], configurable: true },
  capabilities: { githubOAuth: false },
};
const appAccessInput: PlatformDeploymentManifestInput = {
  ...deploymentInput,
  appAccess: 'platform',
};

// Each input and the schema version it gets without minimal runtime logs.
const inputs = [
  { name: 'plain', input: deploymentInput, version: 1 },
  { name: 'workers.dev', input: workersDevInput, version: 2 },
  { name: 'configurable auth', input: configurableInput, version: 3 },
  { name: 'app access', input: appAccessInput, version: 4 },
] as const;

function roundTrip(input: PlatformDeploymentManifestInput) {
  const manifest = createPlatformDeploymentManifest(input);
  return {
    manifest,
    parsed: parsePlatformDeploymentManifest(JSON.parse(JSON.stringify(manifest))),
  };
}

describe('minimal runtime logs deployment manifest', () => {
  it.each(inputs)('round-trips at schema version 5 with $name', ({ input }) => {
    const { manifest, parsed } = roundTrip({ ...input, runtimeLogs: 'minimal' });
    expect(manifest.schemaVersion).toBe(5);
    expect(manifest.runtimeLogs).toBe('minimal');
    expect(parsed).toEqual(manifest);
  });

  it('keeps every other setting at schema version 5', () => {
    const minimal = createPlatformDeploymentManifest({
      ...workersDevInput,
      appAccess: 'custom',
      authentication: { providers: ['cloudflare-access'], accessProtection: true },
      capabilities: { githubOAuth: false },
      runtimeLogs: 'minimal',
    });
    expect(parsePlatformDeploymentManifest(minimal)).toEqual(minimal);
    expect(minimal).toMatchObject({
      appAccess: 'custom',
      application: { workersDev: { subdomain: 'team', installationId: 'team-12345678' } },
      authentication: {
        providers: ['cloudflare-access'],
        configurable: true,
        accessProtection: true,
      },
    });
  });

  it.each(inputs)('drops back to schema version $version when cleared ($name)', (entry) => {
    const minimal = createPlatformDeploymentManifest({ ...entry.input, runtimeLogs: 'minimal' });
    const full = createPlatformDeploymentManifest(entry.input);
    expect(full.schemaVersion).toBe(entry.version);
    expect(full).not.toHaveProperty('runtimeLogs');
    const { runtimeLogs: _runtimeLogs, schemaVersion: _schemaVersion, ...rest } = minimal;
    const { schemaVersion: _fullVersion, ...fullRest } = full;
    expect(rest).toEqual(fullRest);
  });

  it.each(inputs)('rejects runtimeLogs below schema version 5 ($name)', ({ input }) => {
    const manifest = createPlatformDeploymentManifest(input);
    expect(() => parsePlatformDeploymentManifest({ ...manifest, runtimeLogs: 'minimal' })).toThrow(
      'schema version 5',
    );
  });

  it('rejects schema version 5 without runtimeLogs', () => {
    const { runtimeLogs: _runtimeLogs, ...rest } = createPlatformDeploymentManifest({
      ...deploymentInput,
      runtimeLogs: 'minimal',
    });
    expect(() => parsePlatformDeploymentManifest(rest)).toThrow('schema version 5');
  });

  it.each(['full', 'off', '', 1, null])('rejects runtimeLogs %j', (value) => {
    const manifest = createPlatformDeploymentManifest({
      ...deploymentInput,
      runtimeLogs: 'minimal',
    });
    expect(() => parsePlatformDeploymentManifest({ ...manifest, runtimeLogs: value })).toThrow(
      'schema version 5',
    );
    expect(() =>
      createPlatformDeploymentManifest({ ...deploymentInput, runtimeLogs: value as never }),
    ).toThrow();
  });

  it('rejects an invalid appAccess at schema version 5', () => {
    const manifest = createPlatformDeploymentManifest({
      ...appAccessInput,
      runtimeLogs: 'minimal',
    });
    expect(() => parsePlatformDeploymentManifest({ ...manifest, appAccess: 'everyone' })).toThrow(
      'valid appAccess choice',
    );
  });

  it('keeps schema version 4 manifests unchanged', () => {
    const { manifest, parsed } = roundTrip(appAccessInput);
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest).not.toHaveProperty('runtimeLogs');
    expect(parsed).toEqual(manifest);
    const { appAccess: _appAccess, ...withoutAppAccess } = manifest;
    expect(() => parsePlatformDeploymentManifest(withoutAppAccess)).toThrow(
      'valid appAccess choice',
    );
  });
});

describe('minimal runtime logs Worker configs', () => {
  const workers = ['api', 'dispatch', 'emailGateway', 'proxy', 'tail'] as const;
  const minimal = () =>
    workerConfigs({
      deployment: createPlatformDeploymentManifest({ ...deploymentInput, runtimeLogs: 'minimal' }),
    });

  it('keeps default configs unchanged', () => {
    const configs = workerConfigs();
    expect(Object.keys(configs).sort()).toEqual([...workers]);
    for (const worker of workers) {
      expect(configs[worker].observability).toEqual({ enabled: true });
    }
    expect(JSON.stringify(configs)).not.toContain('PLATFORM_RUNTIME_LOGS');
  });

  it('turns Workers Logs off on every platform Worker', () => {
    const configs = minimal();
    for (const worker of workers) {
      expect(configs[worker].observability).toEqual({ enabled: false });
    }
  });

  it('sets PLATFORM_RUNTIME_LOGS only on the api, tail and dispatch Workers', () => {
    const configs = minimal();
    for (const worker of workers) {
      const vars = (configs[worker].vars ?? {}) as Record<string, unknown>;
      if (worker === 'api' || worker === 'tail' || worker === 'dispatch') {
        expect(vars.PLATFORM_RUNTIME_LOGS).toBe('minimal');
      } else {
        expect(vars).not.toHaveProperty('PLATFORM_RUNTIME_LOGS');
      }
    }
  });

  it('adds no bindings or other settings', () => {
    const full = workerConfigs();
    const configs = minimal();
    for (const worker of workers) {
      const { observability: _observability, vars, ...rest } = configs[worker];
      const { observability: _fullObservability, vars: fullVars, ...fullRest } = full[worker];
      expect(rest).toEqual(fullRest);
      const { PLATFORM_RUNTIME_LOGS: _runtimeLogs, ...otherVars } = (vars ?? {}) as Record<
        string,
        unknown
      >;
      expect(otherVars).toEqual(fullVars ?? {});
    }
  });
});

describe('runtime manifest runtimeLogs protocol', () => {
  const digest = '0'.repeat(64);
  const artifact = (path: string) => ({ path, sha256: digest, size: 1 });
  const runtime = {
    artifacts: {
      api: artifact('api.mjs'),
      dispatch: artifact('dispatch.mjs'),
      proxy: artifact('proxy.mjs'),
      tail: artifact('tail.mjs'),
    },
    database: {
      journalSha256: digest,
      lineage: 'void',
      migrations: [],
      protocolVersion: 1,
      rollbackSafeFrom: [],
      schemaDigest: platformDatabaseSchemaDigest('void', []),
    },
    platformVersion: '1.0.0',
    schemaVersion: 2,
  };

  it('leaves runtimeLogs out of older runtime manifests', () => {
    expect(parsePlatformRuntimeManifest(runtime)).not.toHaveProperty('runtimeLogs');
  });

  it('accepts and keeps runtimeLogs: 1', () => {
    expect(parsePlatformRuntimeManifest({ ...runtime, runtimeLogs: 1 }).runtimeLogs).toBe(1);
  });

  it.each([0, 2, '1', true, null])('rejects runtimeLogs %j', (value) => {
    expect(() => parsePlatformRuntimeManifest({ ...runtime, runtimeLogs: value })).toThrow(
      'Unsupported runtime logs protocol.',
    );
  });
});
