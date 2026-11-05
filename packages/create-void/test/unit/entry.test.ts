import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const ENTRY = join(import.meta.dirname, '..', '..', 'src', 'index.ts');

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'create-void-entry-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('create-void entry', () => {
  it('prints the runtime message before any other module links', () => {
    // An old Node fails to link a module that imports a newer API (for example `styleText`
    // from node:util in the bundled prompts). The hook makes every module other than the
    // entry and the runtime check fail the same way, so the message must come first.
    const preload = join(root, 'old-node.mjs');
    writeFileSync(
      preload,
      `import { registerHooks } from 'node:module';
Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '18.20.8' } });
const allowed = [${JSON.stringify(pathToFileURL(ENTRY).href)}, ${JSON.stringify(
        pathToFileURL(join(ENTRY, '..', 'runtime-support.ts')).href,
      )}];
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (!allowed.includes(result.url)) {
      throw new SyntaxError('cannot link ' + result.url);
    }
    return result;
  },
});
`,
    );
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, ENTRY, 'my-app'],
      { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr.split('\n')[0]).toBe(
      `create-void: Node.js 24.22+ or 26.12+ is required. Found Node.js v18.20.8 (${process.execPath}).`,
    );
    expect(readdirSync(root)).not.toContain('my-app');
  });
});
