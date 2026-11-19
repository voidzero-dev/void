import { stripVTControlCharacters } from 'node:util';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { printDeploySuccess } from '../../src/cli/deploy-summary.ts';
import { pc, printNextStep, printSuccess } from '../../src/cli/output.ts';

afterEach(() => vi.restoreAllMocks());

function capture(action: () => void): string {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  action();
  return output;
}

it('keeps a copyable recovery command intact even when it exceeds the terminal width', () => {
  const command =
    'node node_modules/.pnpm/vite-plus@1.7.0/node_modules/vite-plus/bin/vp install && ' +
    './node_modules/.bin/void db generate';
  const message = `Run \`${command}\` to finish setup`;

  expect(stripVTControlCharacters(capture(() => printNextStep(message, { wrap: false })))).toBe(
    `→ ${message}\n`,
  );
});

it('separates the final success with a blank line and exactly one space after the checkmark', () => {
  const output = capture(() =>
    printSuccess('Created and linked to viteconf-void.void.cloudflare.dev'),
  );
  expect(stripVTControlCharacters(output)).toBe(
    '\n✓ Created and linked to viteconf-void.void.cloudflare.dev\n\n',
  );
});

it('colors the whole success green even when a URL or hint was previously styled', () => {
  const colors = pc.createColors(true);
  vi.spyOn(pc, 'green').mockImplementation(colors.green);
  const message = `Linked to ${colors.blue('app.example.com')}. ${colors.dim('Ready to deploy.')}`;
  const output = capture(() => printSuccess(message));
  expect(output).toBe('\n\u001b[32m✓ Linked to app.example.com. Ready to deploy.\u001b[39m\n\n');
});

it('uses the shared success style for published deployments and stays quiet before publication', () => {
  expect(stripVTControlCharacters(capture(() => printDeploySuccess()))).toBe(
    '\n✓ Successfully deployed!\n\n',
  );
  expect(capture(() => printDeploySuccess(false))).toBe('');
});
