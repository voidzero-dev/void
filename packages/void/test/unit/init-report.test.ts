import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { InitReport } from '../../src/cli/init-report.ts';
import { printDone, printNextStep } from '../../src/cli/output.ts';

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({ log: { warn: vi.fn() } }));
vi.mock('../../src/cli/output.ts', () => ({ printDone: vi.fn(), printNextStep: vi.fn() }));

afterEach(() => {
  vi.mocked(log.warn).mockReset();
  vi.mocked(printDone).mockReset();
  vi.mocked(printNextStep).mockReset();
});

describe('InitReport', () => {
  it('keeps a file created in the same run as created when a later step changes it', () => {
    const report = new InitReport();
    report.created('void.config.ts');
    report.updated('void.config.ts', 'pinned compatibility_date');
    report.wrote('void.config.ts', true, 'database: PostgreSQL');

    expect(report.files).toEqual([{ kind: 'created', path: 'void.config.ts', details: [] }]);
  });

  it('lists each change to an existing file once, in order', () => {
    const report = new InitReport();
    report.updated('tsconfig.json', 'extends .void/tsconfig.json');
    report.updated('package.json', 'added void');
    report.updated('tsconfig.json', 'added void/env to types');
    report.updated('tsconfig.json', 'extends .void/tsconfig.json');

    expect(report.files).toEqual([
      {
        kind: 'updated',
        path: 'tsconfig.json',
        details: ['extends .void/tsconfig.json', 'added void/env to types'],
      },
      { kind: 'updated', path: 'package.json', details: ['added void'] },
    ]);
  });

  it('records a write as created or updated by whether the file existed', () => {
    const report = new InitReport();
    report.wrote('.gitignore', false, 'added Void defaults');
    report.wrote('package.json', true, 'added void');

    expect(report.files).toEqual([
      { kind: 'created', path: '.gitignore', details: [] },
      { kind: 'updated', path: 'package.json', details: ['added void'] },
    ]);
  });

  it('lists created files first and aligns the details of updated files', () => {
    const report = new InitReport();
    report.updated('package.json', 'added void');
    report.created('void.config.ts');
    report.updated('vite.config.ts', 'added voidPlugin()');
    report.updated('.gitignore', 'added Void defaults');
    report.created('AGENTS.md');

    expect(report.fileLines()).toEqual([
      '+ void.config.ts',
      '+ AGENTS.md',
      '~ package.json    added void',
      '~ vite.config.ts  added voidPlugin()',
      '~ .gitignore      added Void defaults',
    ]);
  });

  it('prints the changed files, the other finished work, then the next steps', () => {
    const report = new InitReport();
    report.next('Git (optional): git add -A && git commit -m "chore: initial commit"');
    report.done('Linked Void skills for Claude Code');
    report.created('void.config.ts');

    report.print();

    expect(vi.mocked(printDone).mock.calls).toEqual([
      [['Configured Void', '+ void.config.ts']],
      ['Linked Void skills for Claude Code'],
    ]);
    expect(vi.mocked(printNextStep).mock.calls).toEqual([
      ['Git (optional): git add -A && git commit -m "chore: initial commit"'],
    ]);
    expect(vi.mocked(printDone).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(printNextStep).mock.invocationCallOrder[0]!,
    );
  });

  it('describes a new starter in one line instead of its files', () => {
    const report = new InitReport();
    report.created('pages/index.tsx');
    report.starter = 'Created a React Pages starter with D1 (SQLite)';

    report.print();

    expect(vi.mocked(printDone).mock.calls).toEqual([
      ['Created a React Pages starter with D1 (SQLite)'],
    ]);
  });

  it('says when init changed no files', () => {
    new InitReport().print();

    expect(vi.mocked(printDone).mock.calls).toEqual([
      ['Void is already set up. No files changed.'],
    ]);
    expect(printNextStep).not.toHaveBeenCalled();
  });

  it('does not call Void set up after a targeted run that changed no files', () => {
    new InitReport().print(true);

    expect(vi.mocked(printDone).mock.calls).toEqual([['No files changed.']]);
  });
});

describe('an init run that stops early', () => {
  it('warns with the files it changed when a step fails', async () => {
    const report = new InitReport();
    const failure = new Error('npm install failed with exit code 1');

    await expect(
      report.printIfStopped(async () => {
        report.created('void.config.ts');
        report.updated('package.json', 'added void');
        report.done('Linked Void skills for Claude Code');
        report.next('Install typescript as a dev dependency');
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(vi.mocked(log.warn).mock.calls).toEqual([
      ['Setup did not finish. Files changed so far:\n+ void.config.ts\n~ package.json  added void'],
    ]);
    expect(vi.mocked(printDone).mock.calls).toEqual([['Linked Void skills for Claude Code']]);
    expect(vi.mocked(printNextStep).mock.calls).toEqual([
      ['Install typescript as a dev dependency'],
    ]);
  });

  it('warns when a cancelled prompt exits the process', async () => {
    const report = new InitReport();
    const listeners = process.listeners('exit');
    let finish = (): void => {};
    const run = report.printIfStopped(async () => {
      report.created('pages/index.tsx');
      report.starter = 'Created a React Pages starter with D1 (SQLite)';
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    // process.exit() runs the exit listeners. Call the one this run added.
    const added = process.listeners('exit').filter((listener) => !listeners.includes(listener));
    expect(added).toHaveLength(1);
    added[0]!(0);

    expect(vi.mocked(log.warn).mock.calls).toEqual([['Setup did not finish. Done so far:']]);
    expect(vi.mocked(printDone).mock.calls).toEqual([
      ['Created a React Pages starter with D1 (SQLite)'],
    ]);

    finish();
    await run;
    expect(process.listeners('exit')).toEqual(listeners);
  });

  it('prints nothing when it stops before it changes anything', async () => {
    await expect(
      new InitReport().printIfStopped(async () => {
        throw new Error('Cancelled');
      }),
    ).rejects.toThrow('Cancelled');

    expect(log.warn).not.toHaveBeenCalled();
    expect(printDone).not.toHaveBeenCalled();
  });

  it('prints only the summary when the run finishes', async () => {
    const report = new InitReport();
    const listeners = process.listeners('exit');

    await report.printIfStopped(async () => {
      report.created('void.config.ts');
      report.print();
    });

    expect(log.warn).not.toHaveBeenCalled();
    expect(vi.mocked(printDone).mock.calls).toEqual([[['Configured Void', '+ void.config.ts']]]);
    expect(process.listeners('exit')).toEqual(listeners);
  });
});
