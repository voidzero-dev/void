import type { Plugin } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import { voidHono } from '../../src/plugin.ts';

type ConfigPlugin = Plugin & {
  config(): {
    oxc?: { jsx?: { runtime?: string; importSource?: string } };
    resolve?: { dedupe?: Array<string> };
  };
};

describe('voidHono', () => {
  it('registers the config, pages and islands plugins', () => {
    expect(voidHono().map((plugin) => plugin.name)).toEqual([
      'void-hono:config',
      'void-hono:pages',
      'void-hono:islands',
      'void-hono:islands-hmr',
      'void:islands-styles',
    ]);
  });

  it('compiles JSX for Hono and keeps one copy of Hono', () => {
    const config = (voidHono()[0] as ConfigPlugin).config();

    expect(config.oxc?.jsx).toEqual({ runtime: 'automatic', importSource: 'hono/jsx' });
    expect(config.resolve?.dedupe).toEqual(['hono']);
  });
});
