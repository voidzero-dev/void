import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vite-plus/test';
import { prepareFixture, type FixtureApp } from '../../../../test/fixture-app.ts';

let root: string;
const fixture: FixtureApp = {
  framework: 'react',
  name: 'inputs',
  files: { 'pages/old.island.tsx': 'export default function Page() { return <h1>Old</h1>; }' },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-fixture-inputs-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

it('does not replace an existing directory it does not own', () => {
  writeFileSync(join(root, 'keep.txt'), 'existing application');
  expect(() => prepareFixture(fixture, root)).toThrow('unowned fixture directory');
  expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('existing application');
});

it('does not give a different fixture ownership of the same directory', () => {
  prepareFixture(fixture, root);
  expect(() => prepareFixture({ ...fixture, name: 'different' }, root)).toThrow(
    'different application',
  );
  expect(existsSync(join(root, 'pages/old.island.tsx'))).toBe(true);
});

it('replaces the complete source tree while leaving build outputs to their owning task', () => {
  prepareFixture(fixture, root);
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  writeFileSync(join(root, 'dist/client/index.html'), 'previous build');
  prepareFixture(
    {
      ...fixture,
      files: { 'pages/new.island.tsx': 'export default function Page() { return <h1>New</h1>; }' },
    },
    root,
  );
  expect(existsSync(join(root, 'pages/old.island.tsx'))).toBe(false);
  expect(readFileSync(join(root, 'pages/new.island.tsx'), 'utf8')).toContain('New');
  expect(readFileSync(join(root, 'dist/client/index.html'), 'utf8')).toBe('previous build');
  expect(existsSync(join(root, 'node_modules/@void/react/package.json'))).toBe(true);
});
