import { describe, expect, it } from 'vite-plus/test';
import { workerFilesError, workerModuleNameError } from '../../src/deploy/shared.ts';

describe('workerModuleNameError', () => {
  it.each([
    'index.js',
    'index.mjs',
    'chunks/abc.js',
    'server/chunks/_/nitro.mjs',
    'x.wasm',
    'index.js.map',
    'legal.txt',
    'data.json',
    'commonjs.cjs',
  ])('accepts %j', (name) => {
    expect(workerModuleNameError(name)).toBeNull();
  });

  it.each([
    ['', 'must not be empty'],
    ['metadata', 'is reserved'],
    ['METADATA', 'is reserved'],
    ['Metadata', 'is reserved'],
    ['../x.js', 'must not contain empty, "." or ".." path segments'],
    ['chunks/../../x.js', 'must not contain empty, "." or ".." path segments'],
    ['./x.js', 'must not contain empty, "." or ".." path segments'],
    ['a//b.js', 'must not contain empty, "." or ".." path segments'],
    ['chunks/', 'must not contain empty, "." or ".." path segments'],
    ['/x.js', 'must be a relative path'],
    [String.raw`\x.js`, 'must use forward slashes'],
    [String.raw`a\b.js`, 'must use forward slashes'],
    ['a\nb.js', 'must not contain control characters'],
    ['a\u0000.js', 'must not contain control characters'],
    ['x.exe', 'must end in .js, .mjs, .cjs, .wasm, .map, .txt or .json'],
    ['index', 'must end in .js, .mjs, .cjs, .wasm, .map, .txt or .json'],
    ['index.JS', 'must end in .js, .mjs, .cjs, .wasm, .map, .txt or .json'],
  ])('rejects %j', (name, reason) => {
    expect(workerModuleNameError(name)).toBe(reason);
  });
});

describe('workerFilesError', () => {
  it('accepts a module set that contains the default main module', () => {
    expect(workerFilesError(['index.js', 'chunks/abc.js'], undefined)).toBeNull();
  });

  it('accepts a module set that contains the declared main module', () => {
    expect(workerFilesError(['entry.mjs', 'chunks/abc.mjs'], 'entry.mjs')).toBeNull();
  });

  it('accepts an empty module set', () => {
    expect(workerFilesError([], 'entry.mjs')).toBeNull();
  });

  it('names the first invalid entry', () => {
    expect(workerFilesError(['index.js', 'metadata'], undefined)).toBe(
      'workerFiles entry "metadata" is reserved',
    );
  });

  it('rejects a module set without the declared main module', () => {
    expect(workerFilesError(['index.js'], 'entry.mjs')).toBe(
      'workerFiles must include the main module "entry.mjs"',
    );
  });

  it('rejects a module set without the default main module', () => {
    expect(workerFilesError(['worker.js'], undefined)).toBe(
      'workerFiles must include the main module "index.js"',
    );
  });
});
