// Drift test for the Engine A and C images (spec §15.3 "Pinning"): the Dockerfiles, the
// package pins, the lockfiles and the Codex wrapper move together.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vite-plus/test';

const IMAGE = fileURLToPath(new URL('../../image/', import.meta.url));
const read = (path: string) => readFileSync(`${IMAGE}${path}`, 'utf8');
type Lock = { packages: Record<string, { version?: string }> };

describe('scanner image pins', () => {
  test('exact pins match the lockfiles, the Codex wrapper and the Dockerfiles', () => {
    for (const dir of ['claude', 'codex']) {
      const pins = (
        JSON.parse(read(`${dir}/package.json`)) as Lock & {
          dependencies: Record<string, string>;
        }
      ).dependencies;
      const lock = JSON.parse(read(`${dir}/package-lock.json`)) as Lock;
      for (const [name, version] of Object.entries(pins)) {
        expect(
          version.split('.').every((part) => part !== '' && Number.isInteger(Number(part))),
          name,
        ).toBe(true);
        expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
      }
      if (dir === 'codex') {
        expect(pins['@openai/codex']).toBe(pins['@openai/codex-sdk']);
        expect(read('codex-wrapper.sh')).toContain(`EXPECTED_VERSION=${pins['@openai/codex']}\n`);
      }
    }
    const wrapper = read('codex-wrapper.sh');
    for (const flag of [
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      'refusing subcommand',
    ]) {
      expect(wrapper).toContain(flag);
    }
    for (const file of ['Dockerfile.claude', 'Dockerfile.codex']) {
      const text = read(file);
      const from = text.split('\n').find((line) => line.startsWith('FROM '))!;
      expect(from).toContain('@sha256:');
      expect(text).toContain('npm ci --omit=dev --ignore-scripts');
      expect(text).toContain('USER scanner');
    }
  });
});
