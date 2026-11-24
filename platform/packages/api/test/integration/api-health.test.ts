import { PLATFORM_DISABLED_KEY, PLATFORM_SANDBOX_DRAIN_KEY } from '@void/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import app from '../../src/index.ts';
import { sandboxDrainCheckpoints } from '../../src/schema.ts';
import { USAGE_SIGNING_KEY_KV_KEY } from '../../src/usage-auth.ts';
import { setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

async function establishBootstrapSandboxDrainCheckpoint(): Promise<void> {
  await env.db.delete(sandboxDrainCheckpoints);
  await env.db.insert(sandboxDrainCheckpoints).values({
    singleton: true,
    admission_protocol: 0,
    generation: 'deployment-admission-bootstrap',
    state: 'draining',
    phase: 'deployments',
    cursor: { pass: '1' },
  });
}

async function createInstallationClaim(): Promise<void> {
  await env.db.execute(sql`
    CREATE TABLE "__void_platform_installation" (
      "singleton" boolean PRIMARY KEY,
      "installation_id" text NOT NULL
    )
  `);
  await env.db.execute(sql`
    INSERT INTO "__void_platform_installation" ("singleton", "installation_id")
    VALUES (true, 'installation-id')
  `);
}

async function dropInstallationClaim(): Promise<void> {
  await env.db.execute(sql`DROP TABLE "__void_platform_installation"`);
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects health checks while the platform is disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    try {
      const res = await app.fetch(new Request('http://localhost/health'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'installation-id',
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Platform disabled' });
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('fails closed in staging even when routing KV is missing the disabled value', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), {
      ...env,
      PLATFORM_INSTALLATION_ID: 'installation-id',
      PLATFORM_TRAFFIC_STATE: 'staging',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Platform disabled', reason: 'maintenance' });
  });

  it('keeps public API traffic closed during a Sandbox drain', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), {
      ...env,
      PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Platform disabled', reason: 'maintenance' });
  });

  it('admits the authenticated installer Sandbox drain preflight during maintenance', async () => {
    await establishBootstrapSandboxDrainCheckpoint();
    const res = await app.fetch(
      new Request('http://localhost/internal/platform/sandbox-drain', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      {
        ...env,
        PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
        PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: 1,
      state: 'draining',
      generation: 'deployment-admission-bootstrap',
      complete: false,
      updatedAt: expect.any(String),
      phase: 'deployments',
    });
  });

  it('does not trust a stale complete KV mirror without a DB checkpoint', async () => {
    await env.db.delete(sandboxDrainCheckpoints);
    await env.ROUTING.put(
      PLATFORM_SANDBOX_DRAIN_KEY,
      JSON.stringify({
        version: 1,
        generation: 'stale-generation',
        state: 'complete',
        startedAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:01:00.000Z',
        completedAt: '2026-09-16T00:01:00.000Z',
      }),
    );
    try {
      const res = await app.fetch(
        new Request('http://localhost/internal/platform/sandbox-drain', {
          headers: { 'X-Void-Platform-Probe': 'probe-token' },
        }),
        {
          ...env,
          PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
          PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        version: 1,
        state: 'required',
        generation: null,
        complete: false,
        updatedAt: null,
        phase: null,
      });
    } finally {
      await env.ROUTING.delete(PLATFORM_SANDBOX_DRAIN_KEY);
      await establishBootstrapSandboxDrainCheckpoint();
    }
  });

  it('fails the installer preflight closed when the database checkpoint is invalid', async () => {
    await env.db.delete(sandboxDrainCheckpoints);
    await env.db.insert(sandboxDrainCheckpoints).values({
      singleton: true,
      admission_protocol: 0,
      generation: 'invalid-generation',
      state: 'complete',
      phase: 'deployments',
      cursor: { pass: 'invalid' },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.fetch(
        new Request('http://localhost/internal/platform/sandbox-drain', {
          headers: { 'X-Void-Platform-Probe': 'probe-token' },
        }),
        {
          ...env,
          PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
          PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
        },
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        version: 1,
        state: 'invalid',
        complete: false,
        checkpoint: 'sandbox_drain_checkpoints',
      });
    } finally {
      error.mockRestore();
      await establishBootstrapSandboxDrainCheckpoint();
    }
  });

  it('admits installer health checks while public traffic is disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    await createInstallationClaim();
    try {
      const res = await app.fetch(
        new Request('http://localhost/health', {
          headers: { 'X-Void-Platform-Probe': 'probe-token' },
        }),
        {
          ...env,
          PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
          PLATFORM_INSTALLATION_ID: 'installation-id',
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      await dropInstallationClaim();
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('rejects the legacy public installer header while disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    try {
      const res = await app.fetch(
        new Request('http://localhost/health', {
          headers: { 'X-Health-Check': 'void-admin' },
        }),
        {
          ...env,
          PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
          PLATFORM_INSTALLATION_ID: 'installation-id',
        },
      );
      expect(res.status).toBe(503);
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('initializes trusted usage signing material without reading the lifecycle gate', async () => {
    const get = vi.fn(async (key: string) =>
      key === USAGE_SIGNING_KEY_KV_KEY ? 'existing-purpose-separated-key' : null,
    );
    const put = vi.fn(async () => {});
    const res = await app.fetch(new Request('http://localhost/health'), {
      ...env,
      ROUTING: { ...env.ROUTING, get, put } as unknown as typeof env.ROUTING,
    });
    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledExactlyOnceWith(USAGE_SIGNING_KEY_KV_KEY);
    expect(put).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('fails health rather than enabling traffic when usage signing material cannot initialize', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), {
      ...env,
      ROUTING: {
        ...env.ROUTING,
        get: vi.fn(async () => null),
        put: vi.fn(async () => {
          throw new Error('KV unavailable');
        }),
      } as unknown as typeof env.ROUTING,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unhealthy' });
  });

  it('verifies a self-hosted installation through its database claim', async () => {
    await createInstallationClaim();
    try {
      const healthy = await app.fetch(new Request('http://localhost/health'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'installation-id',
      });
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toEqual({ status: 'ok' });

      const wrongDatabase = await app.fetch(new Request('http://localhost/health'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'another-installation',
      });
      expect(wrongDatabase.status).toBe(503);
      expect(await wrongDatabase.json()).toEqual({ status: 'unhealthy' });
    } finally {
      await dropInstallationClaim();
    }
  });
});
