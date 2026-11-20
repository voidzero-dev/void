import { describe, expect, it } from 'vite-plus/test';
import { translateWranglerConfig } from '../../src/cli/cf-config-migrate.ts';
import cases from '../fixtures/cf-config-cases.json' with { type: 'json' };
import { translateWithCodemod } from './cf-config-codemod.ts';

// The codemod reports what a project must install. Void's translation has no project.
const projectFollowUp = /^(?:cf-install|vite-plugin-(?:install|upgrade)|wrangler-upgrade)/;

function own(raw: Record<string, unknown>, mode: string) {
  try {
    return translateWranglerConfig(raw, mode);
  } catch {
    return { config: null, followUps: undefined };
  }
}

// Each case is Wrangler-format settings and the environment to select. Together they contain
// every setting found in Void's own test suite and in the configs of Cloudflare's workers-sdk.
describe.concurrent('Void translates settings as the installed cf codemod does', () => {
  it.for(
    (cases as Array<{ raw: Record<string, unknown>; mode: string }>).map(
      (item, index) => [index, Object.keys(item.raw).join(', ').slice(0, 80), item] as const,
    ),
  )('case %i: %s', async ([, , { raw, mode }]) => {
    const input = structuredClone(raw);
    const reference = await translateWithCodemod(raw, mode);
    const translated = own(raw, mode);

    expect(translated.config).toEqual(reference.config);
    expect(raw).toEqual(input);
    if (reference.config !== null) {
      // Compare as JSON: the reference crossed a process boundary.
      expect(JSON.parse(JSON.stringify(translated.followUps))).toEqual(
        reference.followUps.filter(({ code }) => !projectFollowUp.test(code)),
      );
    }
  });
});

const worker = { name: 'app', compatibility_date: '2026-01-01' };

it.for([
  { ...worker, compatibility_flags: 'nodejs_compat' },
  { ...worker, limits: { cpu_ms: 'many' } },
  { ...worker, observability: { enabled: 'yes' } },
  { ...worker, d1_databases: [{ binding: 'DB', database_id: 5 }] },
])('rejects settings that cf rejects: %j', async (raw) => {
  expect((await translateWithCodemod(raw, 'production')).config).toBeNull();
  expect(() => translateWranglerConfig(raw, 'production')).toThrow(
    'cf could not translate the built Cloudflare configuration.',
  );
});

it.for([
  { name: 7 },
  { ...worker, compatibility_date: 'soon' },
  { ...worker, kv_namespaces: [{ binding: 'KV' }] },
])('translates incomplete settings as cf does: %j', async (raw) => {
  expect(translateWranglerConfig(raw, 'production').config).toEqual(
    (await translateWithCodemod(raw, 'production')).config,
  );
});

it('ignores keys without a JSON value, as a settings file would', () => {
  const settings = { ...worker, vars: { KEPT: 'yes', UNSET: undefined, CALL: () => 1 } };
  expect(translateWranglerConfig(settings, 'production').config).toEqual({
    worker: {
      name: 'app',
      compatibilityDate: '2026-01-01',
      env: { KEPT: { type: 'text', value: 'yes' } },
    },
  });
});
