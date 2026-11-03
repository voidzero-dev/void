import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vite-plus/test';

const outputModule = new URL('../../src/cli/output.ts', import.meta.url).href;
const url = 'https://app.example.com/hello?name=void&mode=preview#content';

function render(hyperlinks: boolean, columns = 80): { url: string; named: string; box: string } {
  const script = `
import { formatLink, formatUrl, note } from ${JSON.stringify(outputModule)};
const url = ${JSON.stringify(url)};
let box = '';
note('Static Site — 1 asset', url, {
  output: { columns: ${columns}, write(chunk) { box += chunk; return true; } },
});
console.log(JSON.stringify({ url: formatUrl(url), named: formatLink('Dashboard', url), box }));
`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_HYPERLINK: hyperlinks ? '1' : '0',
    NO_COLOR: '1',
  };
  delete env.FORCE_COLOR;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    }),
  );
}

describe('terminal links (real capability detection)', () => {
  it.each([40, 80])('keeps the complete link destination in a %s-column box title', (columns) => {
    const output = render(true, columns);
    // ansi-escapes uses BEL to delimit OSC 8 control sequences.
    const opening = `\u001b]8;;${url}\u0007`;
    const closing = '\u001b]8;;\u0007';
    expect(output.url).toBe(`${opening}${url}${closing}`);
    expect(output.named).toBe(`${opening}Dashboard${closing}`);
    const label = columns === 40 ? `${url.slice(0, 34)}…` : url;
    expect(output.box).toContain(` ${opening}${label}${closing}`);
    expect(stripVTControlCharacters(output.box).split('\n')[0]).toContain(` ${label}`);
  });

  it('prints each URL once as plain text when hyperlinks are unsupported or output is redirected', () => {
    const output = render(false);
    expect(output.url).toBe(url);
    expect(output.named).toBe(`Dashboard: ${url}`);
    expect(output.box).not.toContain('\u001b]8;');
    const header = stripVTControlCharacters(output.box).split('\n')[0];
    expect(header.match(/https?:\/\/\S+/)?.[0]).toBe(url);
  });
});
