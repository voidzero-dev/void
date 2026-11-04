import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const INVALID = '---\ntitle\ndescription: Missing colon above\n---\n\n# Invalid\n';
// The page scan reads the layout on its own, so these have to get past that too.
const INVALID_LAYOUTS: Record<string, string> = {
  'mixed-test': '---\ntitle: Invalid layout\nlayout: [unclosed\n---\n\n# Invalid\n',
  'client-script-test': '---\ntitle: Invalid layout\nlayout: !unknown missing\n---\n\n# Invalid\n',
};

describe('invalid frontmatter on the dev server', () => {
  // A copy, since other suites build this playground while a page here is invalid.
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn> | undefined;
  let base: string;
  let validAtStart: string;

  const pageFile = (name: string) => join(playground.root, 'pages/posts', `${name}.md`);
  const pageStatus = async (name: string) => (await fetch(`${base}/posts/${name}`)).status;
  const waitForPageStatus = (name: string, status: number) =>
    expect.poll(() => pageStatus(name), { timeout: 15_000, interval: 200 }).toBe(status);

  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, 'playground/markdown-blog');
    validAtStart = readFileSync(pageFile('getting-started'), 'utf8');
    writeFileSync(pageFile('getting-started'), INVALID);
    for (const [name, source] of Object.entries(INVALID_LAYOUTS)) {
      writeFileSync(pageFile(name), source);
    }

    const server = await startServer((port) => {
      child = spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
      });
      return child;
    }, 30_000);
    base = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    playground?.cleanup();
  });

  it('starts with an invalid page, names it on that page and serves the others', async () => {
    for (const name of ['getting-started', ...Object.keys(INVALID_LAYOUTS)]) {
      const response = await fetch(`${base}/posts/${name}`);
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain(`pages/posts/${name}.md`);
      expect(html).toContain('Invalid frontmatter');
    }

    expect(await pageStatus('code-examples')).toBe(200);

    writeFileSync(pageFile('getting-started'), validAtStart);
    await waitForPageStatus('getting-started', 200);
  });

  // Not the page above: the file watcher can miss a second save right after the first.
  it('survives saving a page with invalid frontmatter and recovers once it is fixed', async () => {
    const valid = readFileSync(pageFile('code-examples'), 'utf8');
    expect(await pageStatus('code-examples')).toBe(200);

    writeFileSync(pageFile('code-examples'), INVALID);
    await waitForPageStatus('code-examples', 500);
    // Repeated requests keep failing rather than rendering the fences as content.
    expect(await pageStatus('code-examples')).toBe(500);

    writeFileSync(pageFile('code-examples'), valid);
    await waitForPageStatus('code-examples', 200);
  });
});
