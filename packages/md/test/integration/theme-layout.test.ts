import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { compile } from '../../src/compile.ts';

const css = ['reset.css', 'prose.css', 'code.css']
  .map((name) => readFileSync(new URL(`../../src/theme/${name}`, import.meta.url), 'utf8'))
  .join('\n');

let browser: Browser;
let html: string;

beforeAll(async () => {
  const nested = await compile('- [ ] parent\n  - [x] child\n  - [ ] another child');
  const loose = await compile('- [ ] first paragraph\n\n  second paragraph\n\n- ordinary item');
  const code = await compile('## Heading\n\n```js\nconst x = 1;\n```');
  html = `<style>${css}</style><main class="void-md" style="margin: 40px">
    <section id="nested">${nested.html}</section>
    <section id="loose">${loose.html}</section>
    <section id="code">${code.html}</section>
  </main>`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

it.each(['ltr', 'rtl'])('keeps task-list content in block flow in %s', async (direction) => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<html dir="${direction}"><body>${html}</body></html>`);
    const layout = await page.evaluate(() => {
      const parent = document.querySelector('#nested li')!;
      const parentText = [...parent.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange();
      range.selectNode(parentText);
      const paragraphs = document.querySelectorAll('#loose li:first-child > p');
      const ordinary = document.querySelector('#loose li:last-child')!;
      return {
        parentBottom: range.getBoundingClientRect().bottom,
        childTop: parent.querySelector('ul')!.getBoundingClientRect().top,
        firstParagraphBottom: paragraphs[0].getBoundingClientRect().bottom,
        secondParagraphTop: paragraphs[1].getBoundingClientRect().top,
        ordinaryMarker: getComputedStyle(ordinary).listStyleType,
        taskMarker: getComputedStyle(parent).listStyleType,
        checkboxes: [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(
          (input) => ({ disabled: input.disabled, checked: input.checked }),
        ),
      };
    });
    expect(layout.childTop).toBeGreaterThan(layout.parentBottom);
    expect(layout.secondParagraphTop).toBeGreaterThanOrEqual(layout.firstParagraphBottom);
    expect(layout.ordinaryMarker).not.toBe('none');
    expect(layout.taskMarker).toBe('none');
    expect(layout.checkboxes).toEqual([
      { disabled: true, checked: false },
      { disabled: true, checked: true },
      { disabled: true, checked: false },
      { disabled: true, checked: false },
    ]);
  } finally {
    await page.close();
  }
});

it.each(['ltr', 'rtl'])('positions heading anchors and copy buttons in %s', async (direction) => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<html dir="${direction}"><body>${html}</body></html>`);
    const layout = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect().toJSON();
      return {
        heading: rect('#code h2'),
        anchor: rect('#code .header-anchor'),
        code: rect('#code [class*="language-"]'),
        copy: rect('#code .copy'),
      };
    });
    if (direction === 'ltr') {
      expect(layout.anchor.right).toBeLessThanOrEqual(layout.heading.left);
      expect(layout.code.right - layout.copy.right).toBeLessThan(
        layout.copy.left - layout.code.left,
      );
    } else {
      expect(layout.anchor.left).toBeGreaterThanOrEqual(layout.heading.right);
      expect(layout.copy.left - layout.code.left).toBeLessThan(
        layout.code.right - layout.copy.right,
      );
    }
    expect(layout.copy.left).toBeGreaterThan(layout.code.left);
    expect(layout.copy.right).toBeLessThan(layout.code.right);
  } finally {
    await page.close();
  }
});
