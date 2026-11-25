import { describe, expect, it } from 'vite-plus/test';
import { translateWranglerConfig } from '../../src/cli/cf-config-migrate.ts';
import cases from '../fixtures/cf-config-cases.json' with { type: 'json' };
import { translateWithCodemod } from './cf-config-codemod.ts';
import type { CodemodTranslation } from './cf-config-codemod.ts';

// The codemod reports what a project must install. Void's translation has no project.
const projectFollowUp = /^(?:cf-install|vite-plugin-(?:install|upgrade)|wrangler-upgrade)/;

function own(raw: Record<string, unknown>, mode: string) {
  try {
    return translateWranglerConfig(raw, mode);
  } catch {
    return { config: null, followUps: undefined };
  }
}

const worker = { name: 'app', compatibility_date: '2026-01-01' };
const rejected = [
  { ...worker, compatibility_flags: 'nodejs_compat' },
  { ...worker, limits: { cpu_ms: 'many' } },
  { ...worker, observability: { enabled: 'yes' } },
  { ...worker, d1_databases: [{ binding: 'DB', database_id: 5 }] },
];
const incomplete = [
  { name: 7 },
  { ...worker, compatibility_date: 'soon' },
  { ...worker, kv_namespaces: [{ binding: 'KV' }] },
];

// One codemod process translates every input of this file. It starts with the first test that
// asks for a reference, so a filtered run that needs none does not pay for it.
const inputs = [
  ...(cases as Array<{ raw: Record<string, unknown>; mode: string }>),
  ...[...rejected, ...incomplete].map((raw) => ({
    raw: raw as Record<string, unknown>,
    mode: 'production',
  })),
];
let references: Promise<Array<CodemodTranslation | Error>> | undefined;
async function reference(raw: Record<string, unknown>): Promise<CodemodTranslation> {
  references ??= translateWithCodemod(inputs);
  const result = (await references)[inputs.findIndex((input) => input.raw === raw)];
  if (!result || result instanceof Error) {
    throw result ?? new Error('The codemod was not given this input.');
  }
  return result;
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
    const expected = await reference(raw);
    const translated = own(raw, mode);

    expect(translated.config).toEqual(expected.config);
    expect(raw).toEqual(input);
    if (expected.config !== null) {
      // Compare as JSON: the reference crossed a process boundary.
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Compare the follow-ups using the JSON emitted by the converter.
      expect(JSON.parse(JSON.stringify(translated.followUps))).toEqual(
        expected.followUps.filter(({ code }) => !projectFollowUp.test(code)),
      );
    }
  });
});

it.for(rejected)('rejects settings that cf rejects: %j', async (raw) => {
  expect((await reference(raw)).config).toBeNull();
  expect(() => translateWranglerConfig(raw, 'production')).toThrow(
    'cf could not translate the built Cloudflare configuration.',
  );
});

it.for(incomplete)('translates incomplete settings as cf does: %j', async (raw) => {
  expect(translateWranglerConfig(raw, 'production').config).toEqual((await reference(raw)).config);
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
