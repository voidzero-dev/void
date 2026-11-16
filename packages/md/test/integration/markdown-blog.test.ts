import { execSync } from 'node:child_process';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { chromium, type Browser, type Page } from 'playwright';
import { describe, expect, it, beforeAll, afterAll } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_BASE: string;
let PREVIEW_BASE: string;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return page;
}

function defineMdClientEntryTests(getBase: () => string) {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  it('static md page without script has no data-md-script attribute', async () => {
    const res = await fetch(`${BASE}/posts/getting-started`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain('data-md-script');
  });
}

function defineCodeCopyTests(getBase: () => string) {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  it('copy button copies the code block without removed diff lines', async () => {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${BASE}/posts/code-examples`);

      const blocks = page.locator('div.language-ts');
      await blocks.first().hover();
      await blocks.first().locator('button.copy').click();
      await blocks.first().locator('button.copy.copied').waitFor();
      const first = await page.evaluate(() => navigator.clipboard.readText());
      expect(first).toContain('interface User');
      expect(first.endsWith('}')).toBe(true);

      const diffBlock = blocks.filter({ hasText: 'voidMarkdown()' });
      await diffBlock.hover();
      await diffBlock.locator('button.copy').click();
      await diffBlock.locator('button.copy.copied').waitFor();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain('voidMarkdown(),');
      expect(copied.split('voidVue()')).toHaveLength(2);

      const jsxBlock = page.locator('div.language-tsx');
      expect(await jsxBlock.locator('.line.diff.remove').textContent()).toBe('  <Old />');
      expect(await jsxBlock.locator('.line.diff.add').textContent()).toBe('  <New />');
      await jsxBlock.hover();
      await jsxBlock.locator('button.copy').click();
      await jsxBlock.locator('button.copy.copied').waitFor();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        '<div>\n  <New />\n</div>',
      );
    } finally {
      await context.close();
    }
  });
}

function defineClientScriptTests(getBase: () => string) {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  it('executes client script in markdown page', async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/posts/client-script-test`);
      await page.waitForSelector('#client-target');

      // SSR renders "pending", client script changes it to "hydrated (success)"
      await page.waitForFunction(
        () => document.getElementById('client-target')?.textContent?.startsWith('hydrated'),
        { timeout: 5000 },
      );

      const text = await page.textContent('#client-target');
      expect(text).toBe('hydrated (success)');
    } finally {
      await page.context().close();
    }
  });

  it('supports island imports and client script in same page', async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/posts/mixed-test`);

      await page.waitForFunction(
        () => document.getElementById('mixed-target')?.textContent?.startsWith('hydrated'),
        { timeout: 5000 },
      );

      const island = await page.$('[data-island]');
      expect(island).not.toBeNull();

      // The client script and island hydrate independently. Wait for the
      // island's handlers before clicking the button rendered by SSR.
      const button = await page.waitForSelector(
        'main [data-island][data-hydrated="true"] button.theme-toggle',
        {
          timeout: 5000,
        },
      );
      const initialText = await button.textContent();
      expect(initialText?.trim()).toBe('Auto');

      await button.click();
      await page.waitForFunction(
        () => document.querySelector('main button.theme-toggle')?.textContent?.trim() === 'Dark',
        { timeout: 5000 },
      );

      const updatedText = await button.textContent();
      expect(updatedText?.trim()).toBe('Dark');
    } finally {
      await page.context().close();
    }
  });
}

function defineSidebarTests(getBase: () => string) {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  it('renders sidebar with post links', async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/posts/getting-started`);
      await page.waitForSelector('aside');

      const links = await page.$$eval('aside a', (els) =>
        els.map((a) => ({ text: a.textContent?.trim(), href: a.getAttribute('href') })),
      );

      const texts = links.map((l) => l.text);
      expect(texts).toContain('Getting Started');
      expect(texts).toContain('Code Examples');

      const hrefs = links.map((l) => l.href);
      expect(hrefs).toContain('/posts/getting-started');
      expect(hrefs).toContain('/posts/code-examples');
    } finally {
      await page.context().close();
    }
  });

  it('navigates between posts via sidebar', async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/posts/getting-started`);
      await page.waitForSelector('aside');

      await page.click('aside a[href="/posts/code-examples"]');
      await page.waitForSelector('h1');

      expect(page.url()).toContain('/posts/code-examples');
      const heading = await page.textContent('h1');
      expect(heading).toContain('Code Examples');
    } finally {
      await page.context().close();
    }
  });

  it('blog index lists all posts', async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`);
      await page.waitForSelector('h1');

      const body = await page.textContent('body');
      expect(body).toContain('Getting Started');
      expect(body).toContain('Code Examples');
      expect(body).toContain('Learn how to use Void');
      expect(body).toContain('Syntax highlighting demos');
    } finally {
      await page.context().close();
    }
  });
}

describe('markdown-blog playground', () => {
  describe('dev', () => {
    let child: ReturnType<typeof spawn>;

    beforeAll(async () => {
      const server = await startServer((port) => {
        child = spawn(
          'vp',
          [
            'run',
            '--filter',
            './playground/markdown-blog',
            'dev',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--strictPort',
          ],
          {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              VOID_INSPECTOR_PORT: 'false',
            },
          },
        );
        return child;
      }, 20_000);
      DEV_BASE = server.base;
    });

    afterAll(async () => {
      if (child) {
        await killChild(child);
      }
    });

    it('injects style for @void/md/theme.css in dev mode', async () => {
      const res = await fetch(`${DEV_BASE}/posts/getting-started`);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('/@vite/client');

      const hasThemeStyle =
        html.includes('void-md') || html.includes('md/theme') || html.includes('md/dist/theme');
      expect(hasThemeStyle).toBe(true);
    });

    it('renders head tags from frontmatter and config', async () => {
      const res = await fetch(`${DEV_BASE}/posts/getting-started`);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('<title>Getting Started | MD Blog</title>');
      expect(html).toContain('<meta name="description" content="Learn how to use Void">');
      expect(html).toContain('<html lang="en"');
      expect(html).toContain('<meta charset="utf-8">');

      const res2 = await fetch(`${DEV_BASE}/posts/code-examples`);
      const html2 = await res2.text();
      expect(html2).toContain('<title>Code Examples | MD Blog</title>');
    });

    defineSidebarTests(() => DEV_BASE);
    defineMdClientEntryTests(() => DEV_BASE);
    defineClientScriptTests(() => DEV_BASE);
    defineCodeCopyTests(() => DEV_BASE);
  });

  describe('production (build + preview)', () => {
    let child: ReturnType<typeof spawn>;

    beforeAll(async () => {
      execSync('vp run --filter ./playground/markdown-blog build', {
        cwd: ROOT,
        stdio: 'pipe',
      });

      const server = await startServer((port) => {
        child = spawn(
          'vp',
          [
            'run',
            '--filter',
            './playground/markdown-blog',
            'preview',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--strictPort',
          ],
          {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              VOID_INSPECTOR_PORT: 'false',
            },
          },
        );
        return child;
      }, 20_000);
      PREVIEW_BASE = server.base;
    });

    afterAll(async () => {
      if (child) {
        await killChild(child);
      }
    });

    it('serves pre-rendered markdown pages', async () => {
      const res = await fetch(`${PREVIEW_BASE}/posts/getting-started`);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('Getting Started');
      expect(html).toContain('<pre');
      expect(html).not.toContain('/@vite/client');
    });

    it('pre-rendered pages contain head tags from frontmatter and config', async () => {
      const res = await fetch(`${PREVIEW_BASE}/posts/getting-started`);
      const html = await res.text();

      expect(html).toContain('<title>Getting Started | MD Blog</title>');
      expect(html).toContain('<meta name="description" content="Learn how to use Void">');
      expect(html).toContain('<html lang="en"');
      expect(html).toContain('<meta charset="utf-8">');

      const res2 = await fetch(`${PREVIEW_BASE}/posts/code-examples`);
      const html2 = await res2.text();
      expect(html2).toContain('<title>Code Examples | MD Blog</title>');
    });

    it('includes theme styles', async () => {
      const res = await fetch(`${PREVIEW_BASE}/posts/getting-started`);
      const html = await res.text();

      const hasThemeCSS =
        html.includes('void-md') || html.includes('<link') || html.includes('<style');
      expect(hasThemeCSS).toBe(true);
    });

    it('md client entry is a separate script from islands client entry', async () => {
      const res = await fetch(`${PREVIEW_BASE}/posts/client-script-test`);
      const html = await res.text();
      const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)![1];
      const tags = body.match(/<script\s+type="module"\s+src="[^"]+"><\/script>/g);
      expect(tags).not.toBeNull();
      expect(tags!.length).toBeGreaterThanOrEqual(2);

      const srcs = tags!.map((t) => t.match(/src="([^"]+)"/)?.[1] ?? '');
      const hasIslands = srcs.some((s) => s.includes('islands-client'));
      const hasMdClient = srcs.some((s) => s.includes('md-client'));
      expect(hasIslands).toBe(true);
      expect(hasMdClient).toBe(true);
    });

    defineSidebarTests(() => PREVIEW_BASE);
    defineMdClientEntryTests(() => PREVIEW_BASE);
    defineClientScriptTests(() => PREVIEW_BASE);
    defineCodeCopyTests(() => PREVIEW_BASE);
  });
});
