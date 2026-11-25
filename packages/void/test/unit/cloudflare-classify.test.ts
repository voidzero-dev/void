import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import { classifyCloudflareDeployApp } from '../../src/cli/cloudflare-deploy/classify.ts';
import type { VoidConfig } from '../../src/config.ts';

const roots: Array<string> = [];

function classify(root: string, config: VoidConfig) {
  return classifyCloudflareDeployApp(
    root,
    config,
    {},
    analyzeApplicationSync(root, { config, environment: 'prod' }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('classifyCloudflareDeployApp', () => {
  it('accepts a SvelteKit project whose routes live under src/routes', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-cloudflare-classify-'));
    roots.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { '@sveltejs/kit': '2.70.3', vite: '8.0.0' } }),
    );
    mkdirSync(join(root, 'src/routes'), { recursive: true });

    expect(classify(root, {})).toEqual({ supported: true });
  });

  it('describes an unresolved static output without claiming static deploys are unsupported', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-cloudflare-classify-'));
    roots.push(root);

    const result = classify(root, { inference: { appType: 'static' } });

    expect(result).toEqual({
      supported: false,
      reason: [
        'deploy: --platform cloudflare could not resolve the static output to deploy.',
        'Set inference.outputDir in void.config.ts, pass --dir with an existing build directory,',
        'or add a supported build tool so Void can locate the generated static assets.',
      ].join('\n'),
    });
  });
});
