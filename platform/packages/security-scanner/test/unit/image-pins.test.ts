// Drift test for the Engine A and C images (spec §15.3 "Pinning"): the Dockerfiles, the
// package pins, the lockfiles, the Codex wrapper and the model list move together.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SECURITY_MODELS } from '@void/platform/security-models';
import { describe, expect, test } from 'vite-plus/test';

const IMAGE = fileURLToPath(new URL('../../image/', import.meta.url));
const read = (path: string) => readFileSync(`${IMAGE}${path}`, 'utf8');
const json = <T>(path: string) => JSON.parse(read(path)) as T;
type Pkg = { dependencies: Record<string, string> };
type Lock = {
  lockfileVersion: number;
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};

const EXACT = /^\d+\.\d+\.\d+$/;

function pinsOf(path: string): Record<string, string> {
  return json<Pkg>(path).dependencies;
}

describe('scanner image pins', () => {
  test('every dependency is an exact version, and the lockfile holds the same one', () => {
    for (const dir of ['claude', 'codex']) {
      const pins = pinsOf(`${dir}/package.json`);
      const lock = json<Lock>(`${dir}/package-lock.json`);
      expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
      expect(lock.packages[''].dependencies).toEqual(pins);
      for (const [name, version] of Object.entries(pins)) {
        expect(version, `${dir}: ${name}`).toMatch(EXACT);
        expect(lock.packages[`node_modules/${name}`]?.version, `${dir}: ${name} in lockfile`).toBe(
          version,
        );
      }
    }
  });

  test('the Codex CLI and SDK are the same version, and the wrapper expects it', () => {
    const pins = pinsOf('codex/package.json');
    expect(pins['@openai/codex']).toBe(pins['@openai/codex-sdk']);
    expect(read('codex-wrapper.sh')).toContain(`EXPECTED_VERSION=${pins['@openai/codex']}\n`);
  });

  test('the wrapper adds every lockdown flag and refuses other subcommands', () => {
    const wrapper = read('codex-wrapper.sh');
    for (const flag of [
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--skip-git-repo-check',
    ]) {
      expect(wrapper).toContain(flag);
    }
    expect(wrapper).toContain('refusing subcommand');
    expect(wrapper).toContain('set -eu');
  });

  test('both Dockerfiles pin the base image by digest, skip install scripts and run as scanner', () => {
    const bases = new Set<string>();
    for (const file of ['Dockerfile.claude', 'Dockerfile.codex']) {
      const text = read(file);
      const from = text.split('\n').find((line) => line.startsWith('FROM '))!;
      expect(from).toMatch(/@sha256:[0-9a-f]{64}$/);
      bases.add(from);
      expect(text).toContain('npm ci --omit=dev --ignore-scripts');
      expect(text).toContain('USER scanner');
      expect(text).toContain('dist/runner.mjs');
      expect(text).toContain('NOTICE');
    }
    expect(bases.size).toBe(1);
  });

  test('the Codex image keeps the license and only the codex binary, and ships the MCP server', () => {
    const text = read('Dockerfile.codex');
    expect(text).toContain('codex-sdk/LICENSE /opt/void-scanner/LICENSE');
    expect(text).toContain('! -name codex-sdk -exec rm -rf');
    expect(text).toContain('void-scan-mcp.mjs');
    expect(text).toContain('codex-wrapper.sh');
    expect(read('NOTICE')).toContain('Apache License 2.0');
  });

  test('the model catalog keeps exactly the OpenAI models the platform lists', () => {
    const listed = SECURITY_MODELS.filter((model) => model.engine === 'codex_sdk')
      .map((model) => model.id.slice('openai/'.length))
      .sort();
    const make = read('codex/make-catalog.mjs');
    const keep = /const keep = \[([^\]]*)\]/
      .exec(make)![1]
      .split(',')
      .map((item) => item.trim().slice(1, -1))
      .sort();
    expect(keep).toEqual(listed);
    for (const setting of [
      "shell_type: 'disabled'",
      'apply_patch_tool_type: null',
      "tool_mode: 'direct'",
    ]) {
      expect(make).toContain(setting);
    }
  });

  test('engine A and C paths in the code match the Dockerfile layout', () => {
    const codex = read('Dockerfile.codex');
    for (const path of [
      'codex-bin',
      'codex-models.json',
      'codex-wrapper.sh',
      'void-scan-mcp.mjs',
    ]) {
      expect(codex).toContain(path);
    }
  });
});
