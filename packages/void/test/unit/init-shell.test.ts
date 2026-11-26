import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { commandInProject } from '../../src/cli/init-shell.ts';

describe('commandInProject', () => {
  it('keeps the command when the shell is in the project', () => {
    expect(commandInProject(process.cwd(), 'vp dev')).toBe('vp dev');
  });

  it('changes into a project folder relative to the shell', () => {
    expect(commandInProject(join(process.cwd(), 'my-app'), 'vp dev')).toBe('cd my-app && vp dev');
  });

  it('quotes the folder for the shell', () => {
    const quoted = process.platform === 'win32' ? '"my app"' : "'my app'";
    expect(commandInProject(join(process.cwd(), 'my app'), 'vp dev')).toBe(
      `cd ${quoted} && vp dev`,
    );
  });

  it.each(['-', '-app'])('keeps cd from reading %s as an option', (folder) => {
    expect(commandInProject(join(process.cwd(), folder), 'vp dev')).toBe(
      `cd ./${folder} && vp dev`,
    );
  });
});
