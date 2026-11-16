import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

// Run after build:all, so integration shards do not rebuild these playgrounds.
const artifacts = {
  analog: ['dist/analog/server/index.mjs', 'dist/analog/public'],
  astro: ['dist/server/entry.mjs'],
  nuxt: ['.output/server/index.mjs', '.output/public'],
  'react-router': ['build/server/index.js', 'build/client'],
  sveltekit: ['.svelte-kit/cloudflare/_worker.js'],
  'tanstack-start': ['dist/server/index.js', 'dist/client'],
  'vinext-app': ['dist/server/index.js', 'dist/client'],
  'vinext-pages': ['dist/ssr/index.js', 'dist/client'],
};

function artifactUrl(playground, path) {
  return new URL(`../playground/${playground}/${path}`, import.meta.url);
}

for (const [playground, paths] of Object.entries(artifacts)) {
  for (const path of paths) {
    assert.ok(existsSync(artifactUrl(playground, path)), `${playground}/${path} was not built`);
  }
}

function checkBindings(playground, configPath, { cron } = {}) {
  const config = JSON.parse(readFileSync(artifactUrl(playground, configPath), 'utf8'));
  assert.ok(
    config.d1_databases?.some((binding) => binding.binding === 'DB'),
    `${playground} is missing the inferred DB binding`,
  );
  assert.ok(
    config.kv_namespaces?.some((binding) => binding.binding === 'KV'),
    `${playground} is missing the inferred KV binding`,
  );
  assert.equal(
    config.assets?.directory,
    '../client',
    `${playground} has the wrong asset directory`,
  );
  if (cron) {
    assert.deepEqual(config.triggers?.crons, [cron], `${playground} has the wrong cron schedule`);
  }
}

checkBindings('react-router', 'build/server/wrangler.json');
checkBindings('tanstack-start', 'dist/server/wrangler.json', { cron: '0 * * * *' });
checkBindings('vinext-app', 'dist/server/wrangler.json');
checkBindings('vinext-pages', 'dist/ssr/wrangler.json');

// Each of these playgrounds' env.ts declares this default, and nothing else mentions it. A server
// bundle without it reads raw values: a bundler can drop an import kept only for its side effect.
const ENV_SCHEMA_MARKER = '48213';
const envSchemaServerDirectories = {
  'react-router': 'build/server',
  'tanstack-start': 'dist/server',
  'vinext-app': 'dist/server',
  'vinext-pages': 'dist/ssr',
};

function containsMarker(directory) {
  return readdirSync(directory).some((name) => {
    const path = new URL(encodeURIComponent(name), `${directory.href}/`);
    return statSync(path).isDirectory()
      ? containsMarker(path)
      : /\.m?js$/.test(name) && readFileSync(path, 'utf8').includes(ENV_SCHEMA_MARKER);
  });
}

for (const [playground, directory] of Object.entries(envSchemaServerDirectories)) {
  assert.ok(
    containsMarker(artifactUrl(playground, directory)),
    `${playground} does not bundle env.ts into its server output`,
  );
}

console.log('Verified metaframework build artifacts, inferred bindings and env schemas.');
