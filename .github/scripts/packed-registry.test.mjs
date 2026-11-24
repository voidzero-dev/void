import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path/posix';
import { test } from 'node:test';
import { inspectPackage } from './packed-registry.mjs';

function createPackage(t, overrides = {}, includeLicense = true, extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), 'void-packed-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'package');
  mkdirSync(directory);
  const manifest = {
    name: '@void/test',
    version: '0.0.0',
    description: 'A Void test package.',
    license: 'MIT',
    homepage: 'https://void.cloud',
    bugs: { url: 'https://github.com/voidzero-dev/void/issues' },
    exports: './index.mjs',
    ...overrides,
  };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'index.mjs'), 'export {};\n');
  if (includeLicense) {
    writeFileSync(join(directory, 'LICENSE'), 'MIT License\n');
  }
  for (const [path, content] of Object.entries(extraFiles)) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const tarball = join(root, 'package.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
  return tarball;
}

void test('accepts complete metadata and license in a real package tarball', (t) => {
  const inspected = inspectPackage(createPackage(t));
  assert.equal(inspected.manifest.name, '@void/test');
  assert.match(inspected.integrity, /^sha512-/);
});

for (const [field, error] of [
  ['description', /missing package description/],
  ['license', /package license must be MIT/],
  ['homepage', /homepage must be an HTTPS URL/],
  ['bugs', /bugs.url must be an HTTPS URL/],
]) {
  void test(`rejects a packed manifest missing ${field}`, (t) => {
    assert.throws(() => inspectPackage(createPackage(t, { [field]: undefined })), error);
  });
}

void test('rejects blank descriptions and invalid package links', (t) => {
  for (const overrides of [
    { description: '  ' },
    { homepage: 'void.cloud' },
    { homepage: 'http://void.cloud' },
    { bugs: { url: 'not a URL' } },
  ]) {
    assert.throws(() => inspectPackage(createPackage(t, overrides)));
  }
});

void test('requires the license file as well as its manifest field', (t) => {
  assert.throws(() => inspectPackage(createPackage(t, {}, false)), /missing packaged LICENSE/);
});

const imageManifest = {
  name: '@void/image-renderer-takumi',
  exports: { '.': './dist/index.mjs' },
  dependencies: { 'takumi-js': '~2.20.0' },
  peerDependencies: { void: '^1.8.0' },
};
const imageFiles = {
  'dist/index.mjs': 'import { render } from "takumi-js";\nimport("takumi-js/wasm");\n',
  'licenses/Roboto.txt': 'SIL Open Font License\n',
};

void test('accepts the renderer entry with external Takumi and its font license', (t) => {
  inspectPackage(createPackage(t, imageManifest, true, imageFiles));
});

void test('rejects renderer packages that omit the root export or void peer', (t) => {
  for (const overrides of [{ exports: {} }, { peerDependencies: {} }]) {
    assert.throws(() =>
      inspectPackage(createPackage(t, { ...imageManifest, ...overrides }, true, imageFiles)),
    );
  }
});

void test('rejects image packages that omit the font license or bundle Takumi', (t) => {
  for (const files of [
    { 'dist/index.mjs': imageFiles['dist/index.mjs'] },
    { ...imageFiles, 'dist/index.mjs': 'export class ImageResponse {}\n' },
  ]) {
    assert.throws(() => inspectPackage(createPackage(t, imageManifest, true, files)));
  }
});
