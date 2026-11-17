import { join } from 'node:path';
import { loadConfigFromFile } from 'vite-plus';
import { expect, it } from 'vite-plus/test';
import { parseCLI } from 'vite-plus/test/node';

it('keeps a forwarded filename as a filter for the native iteration command', async () => {
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    join(import.meta.dirname, '../../../../vite.config.ts'),
  );
  const task = loaded?.config.run?.tasks?.['test:iterate'];
  if (
    !task ||
    typeof task !== 'object' ||
    !('command' in task) ||
    typeof task.command !== 'string'
  ) {
    throw new Error('Expected a native Vitest command');
  }
  const file = 'packages/void/test/unit/plugin-routing.test.ts';
  const { filter, options } = parseCLI(
    `${task.command.replace(/^vp test/, 'vitest')} ${file} --project unit`,
  );
  expect(filter).toEqual([file]);
  expect(options.sinceLastRun).toBeTruthy();
  expect(options.project).toEqual(['unit']);
});
