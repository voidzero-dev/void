import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { intro, outro } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { runLogsCommand } from '../../src/cli/logs.ts';
import { sanitizeTerminalLogText } from '../../src/cli/terminal-log-text.ts';

const logsFixture = vi.hoisted(() => ({
  entries: undefined as Array<unknown> | undefined,
  runtimeLogs: undefined as 'minimal' | undefined,
}));

vi.mock('../../src/cli/auth.ts', () => ({ getToken: () => 'fixture-token' }));
vi.mock('../../src/cli/project.ts', () => ({
  readDeploymentPlatform: () => 'void',
  readProjectConfig: () => ({ projectId: 'fixture-project', slug: 'my-app' }),
}));
vi.mock('../../src/cli/client.ts', () => ({
  PlatformClient: class {
    async getLogs() {
      const runtimeLogs = logsFixture.runtimeLogs ? { runtimeLogs: logsFixture.runtimeLogs } : {};
      if (logsFixture.entries) {
        return { entries: logsFixture.entries, ...runtimeLogs };
      }
      return {
        entries: [
          {
            timestamp: 0,
            method: 'POST',
            url: '/api/comments',
            status: '500',
            outcome: 'exception',
            logs: [
              {
                level: 'warn',
                message: ['Cache miss. Refreshing the published page in the background.'],
              },
              {
                level: 'error',
                message: ['Comment could not be saved.\nPlease retry after signing in.'],
              },
            ],
            exceptions: [
              { name: 'Error', message: 'DATABASE_URL is not configured for this deployment.' },
            ],
          },
        ],
        ...runtimeLogs,
      };
    }
  },
}));
vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => ({
  ...(await original<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  intro: vi.fn(),
  outro: vi.fn(),
}));
vi.mock('../../src/cli/output.ts', async (original) => {
  const { default: colors } = await import('picocolors');
  const pc = colors.createColors(true);
  return {
    ...(await original<typeof import('../../src/cli/output.ts')>()),
    pc,
    dim: pc.dim,
  };
});

afterEach(() => {
  logsFixture.entries = undefined;
  logsFixture.runtimeLogs = undefined;
  vi.restoreAllMocks();
});

/** Runs `void logs` with a stdout of the given width and returns the printed lines. */
async function printLogs(columns: number): Promise<Array<string>> {
  const output = Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { columns },
  );
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as typeof process.stdout);
  const print = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runLogsCommand('/fixture', '', '1h');
  return print.mock.calls.map((args) => String(args[0] ?? ''));
}

const UNSAFE_SEQUENCES = ['\x1b]', '\x1b[2J', '\r', '\x07', '\u009b'];

it.each([40, 80])('aligns wrapped log messages and exceptions at %i columns', async (columns) => {
  const messages = await printLogs(columns);
  expect(intro).not.toHaveBeenCalled();
  expect(stripVTControlCharacters(vi.mocked(outro).mock.calls.at(-1)![0]!)).toBe('1 log entry');
  const warn = messages.find((line) => line.includes('[warn]'))!;
  const error = messages.find((line) => line.includes('[error]'))!;
  const exception = messages.find((line) => line.includes('[exception]'))!;
  expect(warn).toContain('\x1b[33m[warn]');
  expect(error).toContain('\x1b[31m[error]');
  expect(exception).toContain('\x1b[31m[exception]');
  expect(error).toContain('\n          Please retry');
  for (const [message, indent] of [
    [warn, 9],
    [error, 10],
    [exception, 14],
  ] as const) {
    const lines = stripVTControlCharacters(message).split('\n');
    expect(lines.every((line) => line.length <= columns)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith(' '.repeat(indent)))).toBe(true);
  }
});

it('drops terminal control sequences from app log text but keeps colors and line breaks', async () => {
  logsFixture.entries = [
    {
      timestamp: 0,
      method: 'GET',
      url: '/search?q=\x1b]52;c;ZXZpbA==\x07',
      status: '500',
      outcome: 'exception',
      logs: [
        {
          level: 'error',
          message: ['a\x1b]52;c;ZXZpbA==\x07b\x1b[2J\rc\n\x1b[31mred\x1b[0m'],
        },
      ],
      exceptions: [
        {
          name: 'Error',
          message: 'see \x1b]8;;https://evil.example\x07click\x1b]8;;\x07 then \u009b2J',
        },
      ],
    },
  ];
  const messages = await printLogs(120);

  const printed = messages.join('\n');
  for (const unsafe of UNSAFE_SEQUENCES) {
    expect(printed).not.toContain(unsafe);
  }
  expect(printed).toContain('\x1b[31mred');
  expect(printed).not.toContain('evil.example');
  expect(printed).toContain('Error: see click then 2J');
  const error = messages.find((line) => line.includes('[error]'))!;
  expect(stripVTControlCharacters(error).split('\n')).toEqual(['  [error] abc', '          red']);
});

it('ends app log text with a reset so its styles cannot hide the next printed line', async () => {
  logsFixture.entries = [
    {
      timestamp: 0,
      method: 'GET',
      url: '/search?q=\x1b[8m',
      status: '200',
      outcome: 'ok',
      logs: [{ level: 'log', message: ['q=\x1b[8m'] }],
      exceptions: [{ name: 'Error', message: 'x\x1b[7;30;40m' }],
    },
  ];
  const styled = (await printLogs(120)).filter(
    (line) => line.includes('\x1b[8m') || line.includes('\x1b[7;30;40m'),
  );
  expect(styled).toHaveLength(3);
  for (const line of styled) {
    expect(line.lastIndexOf('\x1b[0m')).toBeGreaterThan(
      Math.max(line.lastIndexOf('\x1b[8m'), line.lastIndexOf('\x1b[7;30;40m')),
    );
  }
});

it('keeps color codes, newlines and tabs, and removes other escape sequences whole', () => {
  expect(sanitizeTerminalLogText('\x1b[1;38;2;255;0;0mbold\x1b[0m\tcol\nnext')).toBe(
    '\x1b[1;38;2;255;0;0mbold\x1b[0m\tcol\nnext\x1b[0m',
  );
  expect(sanitizeTerminalLogText('q=\x1b[8m hidden')).toBe('q=\x1b[8m hidden\x1b[0m');
  expect(sanitizeTerminalLogText('\x1b[38:2::255:0:0mred')).toBe('\x1b[38:2::255:0:0mred\x1b[0m');
  expect(sanitizeTerminalLogText('a\x1b]52;c;ZXZpbA==\x07b')).toBe('ab');
  expect(
    sanitizeTerminalLogText('see \x1b]8;;https://evil.example/\x1b\\docs\x1b]8;;\x1b\\ now'),
  ).toBe('see docs now');
  expect(sanitizeTerminalLogText('a\x1b]52;c;ZXZpbA== b')).toBe('a]52;c;ZXZpbA== b');
  expect(sanitizeTerminalLogText('a\x1b]0;title\nb\x1b[31mc')).toBe('a]0;title\nb\x1b[31mc\x1b[0m');
  expect(sanitizeTerminalLogText('x\x1b[2J\x1b[?25l\x1b[1A\x1b[>4;1my')).toBe('xy');
  expect(sanitizeTerminalLogText('a\x1b[2J\x1b[Hb')).toBe('ab');
  expect(sanitizeTerminalLogText('progress 50%\x1b[K done')).toBe('progress 50% done');
  expect(sanitizeTerminalLogText('over\rwrite')).toBe('overwrite');
  expect(sanitizeTerminalLogText('\u009b2J\u0085\u007f\u0000\u0008end')).toBe('2Jend');
  expect(sanitizeTerminalLogText('plain text, ünïcode ✓')).toBe('plain text, ünïcode ✓');
});

it('prints stack frames under the error that logged them', async () => {
  logsFixture.entries = [
    {
      timestamp: 0,
      method: 'GET',
      url: '/sponsors.svg',
      status: '500',
      outcome: 'ok',
      logs: [
        {
          level: 'error',
          message: ["TypeError: Cannot read properties of undefined (reading 'href')"],
          errorInfo: [
            {
              name: 'TypeError',
              message: "Cannot read properties of undefined (reading 'href')",
              stack: '    at assets/resvg.js:14881:64\n    at assets/resvg.js:15409:3',
            },
          ],
        },
        {
          level: 'error',
          message: ['Render failed:', 'Error: font missing', 'retrying'],
          errorInfo: [
            null,
            {
              name: 'Error',
              message: 'font missing',
              stack: 'Error: font missing\n    at render (index.js:10:5)',
            },
            null,
          ],
        },
        {
          level: 'error',
          message: ['Error'],
          errorInfo: [{ name: 'Error', message: '', stack: 'Error\n    at g (y.js:2:2)' }],
        },
        {
          level: 'warn',
          message: ['Error: retry later'],
          errorInfo: [{ name: 'Error', message: 'retry later' }],
        },
      ],
      exceptions: [
        {
          name: 'Error',
          message: 'Worker threw',
          stack: 'Error: Worker threw\n    at fetch (index.js:1:1)',
        },
        { name: 'Error', message: 'boom', stack: 'Error: boom' },
        { name: 'Error', message: 'Worker exceeded CPU time limit.' },
      ],
    },
  ];
  const messages = await printLogs(120);
  const header = messages.findIndex((line) => line.includes('/sponsors.svg'));
  expect(header).toBeGreaterThanOrEqual(0);
  expect(
    messages.slice(header + 1).flatMap((message) => stripVTControlCharacters(message).split('\n')),
  ).toEqual([
    "  [error] TypeError: Cannot read properties of undefined (reading 'href')",
    '              at assets/resvg.js:14881:64',
    '              at assets/resvg.js:15409:3',
    '  [error] Render failed: Error: font missing',
    '              at render (index.js:10:5)',
    '          retrying',
    '  [error] Error',
    '              at g (y.js:2:2)',
    '  [warn] Error: retry later',
    '  [exception] Error: Worker threw',
    '                  at fetch (index.js:1:1)',
    '  [exception] Error: boom',
    '  [exception] Error: Worker exceeded CPU time limit.',
  ]);
  expect(messages.join('\n')).toContain('\x1b[2m    at assets/resvg.js:14881:64');
});

it('drops terminal control sequences from stack frames', async () => {
  logsFixture.entries = [
    {
      timestamp: 0,
      method: 'GET',
      url: '/sponsors.svg',
      status: '500',
      outcome: 'exception',
      logs: [
        {
          level: 'error',
          message: ['Error: boom'],
          errorInfo: [
            {
              name: 'Error',
              message: 'boom',
              stack: 'Error: boom\n    at \x1b]52;c;ZXZpbA==\x07f (a.js:1:1)\x1b[2J\r',
            },
          ],
        },
      ],
      exceptions: [
        {
          name: 'Error',
          message: 'x',
          stack:
            'Error: x\n    at \x1b]8;;https://evil.example\x07g\x1b]8;;\x07 (b.js:2:2)\u009b2J',
        },
      ],
    },
  ];
  const printed = (await printLogs(120)).join('\n');
  for (const unsafe of UNSAFE_SEQUENCES) {
    expect(printed).not.toContain(unsafe);
  }
  expect(printed).not.toContain('evil.example');
  const plain = stripVTControlCharacters(printed);
  expect(plain).toContain('    at f (a.js:1:1)');
  expect(plain).toContain('    at g (b.js:2:2)2J');
});

it('notes minimal runtime logs and prints entries without a URL cleanly', async () => {
  logsFixture.runtimeLogs = 'minimal';
  logsFixture.entries = [
    {
      timestamp: 0,
      method: 'GET',
      url: '',
      status: '500',
      outcome: 'exception',
      logs: [{ level: 'warn', message: [], timestamp: 0 }],
      exceptions: [{ name: 'TypeError', message: '', timestamp: 0 }],
    },
  ];
  const lines = (await printLogs(120)).map((line) => stripVTControlCharacters(line));
  expect(lines[1]).toBe(
    'Log messages, exception messages and URLs are not recorded on this platform.',
  );
  // One space between each part: time, method, status.
  expect(lines[2]!.split(' ').slice(1)).toEqual(['GET', '500']);
  expect(lines.slice(3)).toEqual(['  [warn]', '  [exception] TypeError']);
});

it('keeps the full-mode output for entries without a URL or message', async () => {
  logsFixture.entries = [
    {
      timestamp: 0,
      method: 'GET',
      url: '',
      status: '500',
      outcome: 'exception',
      logs: [{ level: 'warn', message: [], timestamp: 0 }],
      exceptions: [{ name: 'TypeError', message: '', timestamp: 0 }],
    },
  ];
  const lines = (await printLogs(120)).map((line) => stripVTControlCharacters(line));
  expect(lines[1]!.split(' ').slice(1)).toEqual(['GET', '-', '500']);
  expect(lines.slice(2)).toEqual(['  [warn] ', '  [exception] TypeError: ']);
});

it('notes minimal runtime logs even when there are no entries', async () => {
  logsFixture.runtimeLogs = 'minimal';
  logsFixture.entries = [];
  const lines = (await printLogs(120)).map((line) => stripVTControlCharacters(line));
  expect(lines).toEqual([
    '',
    'Log messages, exception messages and URLs are not recorded on this platform.',
  ]);
  expect(vi.mocked(outro).mock.calls.at(-1)![0]).toBe('No logs found in the last 1h.');
});

it('prints no note for full runtime logs', async () => {
  const lines = await printLogs(120);
  expect(lines.join('\n')).not.toContain('not recorded on this platform');
});
