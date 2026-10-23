import { describe, it, expect } from 'vite-plus/test';
import { FRAMEWORK_PRESETS } from '../../src/cli/preset.ts';

describe('FRAMEWORK_PRESETS', () => {
  it('has preset for sveltekit', () => {
    const preset = FRAMEWORK_PRESETS.sveltekit;
    expect(preset).toBeDefined();
    expect(preset.buildCommand).toBe('vite build');
    expect(preset.workerDir).toBe('.svelte-kit/cloudflare');
    expect(preset.workerMain).toBe('_worker.js');
    expect(preset.assetsDir).toBe('.svelte-kit/cloudflare');
  });

  it('has preset for nuxt', () => {
    const preset = FRAMEWORK_PRESETS.nuxt;
    expect(preset).toBeDefined();
    expect(preset.buildCommand).toBe('nuxt build');
    expect(preset.workerDir).toBe('.output/server');
    expect(preset.workerMain).toBe('index.mjs');
    expect(preset.assetsDir).toBe('.output/public');
  });

  it('has preset for analog', () => {
    const preset = FRAMEWORK_PRESETS.analog;
    expect(preset).toBeDefined();
    expect(preset.buildCommand).toBe('vite build');
    expect(preset.workerDir).toBe('dist/analog/server');
    expect(preset.workerMain).toBe('index.mjs');
    expect(preset.assetsDir).toBe('dist/analog/public');
  });

  it('has preset for astro', () => {
    const preset = FRAMEWORK_PRESETS.astro;
    expect(preset).toBeDefined();
    expect(preset.buildCommand).toBe('astro build');
    expect(preset.workerDir).toBe('dist/server');
    expect(preset.workerMain).toBe('entry.mjs');
    expect(preset.assetsDir).toBe('dist/client');
  });

  it('has preset for pracht', () => {
    const preset = FRAMEWORK_PRESETS.pracht;
    expect(preset).toBeDefined();
    expect(preset.cloudflareArtifact).toBe('worker-output');
    expect(preset.buildCommand).toBe('pracht build');
    expect(preset.workerDir).toBe('dist/server');
    expect(preset.workerMain).toBe('worker.js');
    expect(preset.assetsDir).toBe('dist/client');
    expect(preset.htmlHandling).toBe('drop-trailing-slash');
  });

  it.each([
    ['tanstack-start', 'dist/server'],
    ['react-router', 'build/server'],
    ['vinext-app', 'dist/server'],
    ['vinext-pages', 'dist/ssr'],
  ])('matches the generated %s Cloudflare Worker directory', (name, workerDir) => {
    const preset = FRAMEWORK_PRESETS[name];
    expect(preset.cloudflareArtifact).toBe('vite-plugin');
    expect(preset.workerDir).toBe(workerDir);
    expect(preset.workerMain).toBe('index.js');
  });
});
