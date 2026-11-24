import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  expandDotenv,
  parseDotenv,
  parseDotenvFile,
  scanWranglerDotenvKeys,
} from '../../src/shared/dotenv.ts';

/**
 * Parser + expander unit coverage. These are the lowest-level helpers behind
 * every CLI path that reads `.env*` files, so we want deliberate regression
 * tests for the expansion edge cases: escapes, nested refs, cycles, missing
 * refs, and the no-process.env guarantee.
 */

describe('parseDotenv', () => {
  it('parses basic KEY=VALUE', () => {
    expect(parseDotenv('FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('strips matching double quotes', () => {
    expect(parseDotenv('FOO="bar baz"')).toEqual({ FOO: 'bar baz' });
  });

  it('strips matching single quotes', () => {
    expect(parseDotenv("FOO='bar baz'")).toEqual({ FOO: 'bar baz' });
  });

  it('skips blanks, comments, and lines without =', () => {
    expect(parseDotenv('\n   \n# comment\nNO_EQUALS\n')).toEqual({});
  });

  it('parses a multi-line file', () => {
    const out = parseDotenv('A=1\nB=2\n# comment\n\nC=3\n');
    expect(out).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('skips invalid keys', () => {
    const out = parseDotenv('GOOD=1\n1BAD=2\nALSO-BAD=3\n');
    expect(out).toEqual({ GOOD: '1' });
  });

  it('expands references to earlier keys', () => {
    const out = parseDotenv('BASE=https://example.com\nAPI=${BASE}/v1\n');
    expect(out).toEqual({ BASE: 'https://example.com', API: 'https://example.com/v1' });
  });
});

describe('parseDotenv — lines Vite and Wrangler both read', () => {
  // Expected values come from running Vite's parser (node:util parseEnv)
  // and Wrangler's (dotenv 16.3.1) on the same lines; both agree on these.
  it.each([
    ['export A=1', { A: '1' }],
    ['export  B = 2', { B: '2' }],
    ['  export C=3', { C: '3' }],
    ['export J="q"', { J: 'q' }],
    ["export K='q'", { K: 'q' }],
    ['export=5', { export: '5' }],
    ['export =6', { export: '6' }],
    ['exportE=7', { exportE: '7' }],
    ['export F', {}],
  ])('%j', (line, expected) => {
    expect(parseDotenv(line)).toEqual(expected);
  });

  it('lets a later export line win over an earlier plain line', () => {
    expect(parseDotenv('VITE_A=2\nexport VITE_A=1\n')).toEqual({ VITE_A: '1' });
  });

  it('expands references to exported keys', () => {
    expect(parseDotenv('export BASE=https://a.com\nURL=${BASE}/v1\n')).toEqual({
      BASE: 'https://a.com',
      URL: 'https://a.com/v1',
    });
  });

  // The runtimes disagree on these, so Void reads neither.
  it.each([
    // Wrangler reads K=v; Vite does not read the line.
    ['K: v'],
    // Wrangler reads D=4; Vite reads the key "export\tD".
    ['export\tD=4'],
    // Vite reads the key "export H"; Wrangler does not read the line.
    ['export export H=9'],
  ])('skips %j', (line) => {
    expect(parseDotenv(line)).toEqual({});
  });
});

describe('parseDotenv — values read as Vite reads them', () => {
  // Expected values come from Vite's parser (node:util parseEnv); Wrangler's
  // dotenv 16 reads the same values for these lines.
  it.each([
    ['inline comment', 'A=val # note', { A: 'val' }],
    ['comment after a quoted value', 'A="v" # note', { A: 'v' }],
    ['# inside quotes', 'A="a # b"', { A: 'a # b' }],
    ['escaped newline in double quotes', String.raw`A="a\nb"`, { A: 'a\nb' }],
    ['escaped newline in single quotes', String.raw`A='a\nb'`, { A: String.raw`a\nb` }],
    ['multi-line double quotes', 'A="line1\nline2"\nB=after', { A: 'line1\nline2', B: 'after' }],
    ['backticks', 'A=`back`', { A: 'back' }],
    [
      'export with an inline comment',
      'export DATABASE_URL="postgres://db/app" # local',
      { DATABASE_URL: 'postgres://db/app' },
    ],
  ])('%s', (_name, content, expected) => {
    expect(parseDotenv(content)).toEqual(expected);
  });
});

describe('parseDotenvFile', () => {
  it('returns {} for a missing file', () => {
    expect(parseDotenvFile('/definitely/not/a/real/path/.env')).toEqual({});
  });

  it('reads an on-disk file and expands', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-dotenv-'));
    const file = join(root, '.env');
    writeFileSync(file, 'HOST=api.example.com\nURL=https://${HOST}\n');
    expect(parseDotenvFile(file)).toEqual({
      HOST: 'api.example.com',
      URL: 'https://api.example.com',
    });
  });
});

describe('expandDotenv — ${VAR} form', () => {
  it('resolves a single reference', () => {
    expect(expandDotenv({ BASE: 'https://a.com', URL: '${BASE}/v1' })).toEqual({
      BASE: 'https://a.com',
      URL: 'https://a.com/v1',
    });
  });

  it('resolves nested references transitively', () => {
    expect(expandDotenv({ A: '${B}', B: '${C}', C: 'deep' })).toEqual({
      A: 'deep',
      B: 'deep',
      C: 'deep',
    });
  });

  it('expands multiple refs in a single value', () => {
    expect(expandDotenv({ A: '1', B: '2', C: '${A}-${B}' })).toEqual({
      A: '1',
      B: '2',
      C: '1-2',
    });
  });

  it('expands to empty string for missing references', () => {
    expect(expandDotenv({ URL: '${MISSING}/path' })).toEqual({ URL: '/path' });
  });

  it('leaves unterminated ${... literally', () => {
    expect(expandDotenv({ A: '${UNCLOSED' })).toEqual({ A: '${UNCLOSED' });
  });

  it('leaves ${<non-identifier>} literally', () => {
    expect(expandDotenv({ A: '${1BAD}' })).toEqual({ A: '${1BAD}' });
  });
});

describe('expandDotenv — $VAR bare form', () => {
  it('resolves a bare ref up to the first non-identifier char', () => {
    expect(expandDotenv({ NAME: 'alice', GREET: 'hi $NAME!' })).toEqual({
      NAME: 'alice',
      GREET: 'hi alice!',
    });
  });

  it('stops at hyphens and slashes', () => {
    expect(expandDotenv({ HOST: 'x', URL: 'http://$HOST/path' })).toEqual({
      HOST: 'x',
      URL: 'http://x/path',
    });
  });

  it('leaves a bare $ alone when not followed by an identifier', () => {
    expect(expandDotenv({ A: 'cost $5' })).toEqual({ A: 'cost $5' });
    expect(expandDotenv({ A: 'trailing $' })).toEqual({ A: 'trailing $' });
  });
});

describe('expandDotenv — escapes', () => {
  it(String.raw`treats \$VAR as a literal $VAR (consuming the backslash)`, () => {
    expect(expandDotenv({ A: String.raw`\$NOT_EXPANDED` })).toEqual({ A: '$NOT_EXPANDED' });
  });

  it('treats \\${VAR} as a literal ${VAR}', () => {
    expect(expandDotenv({ A: '\\${LITERAL}' })).toEqual({ A: '${LITERAL}' });
  });

  it('mixes escaped and non-escaped refs in one value', () => {
    expect(expandDotenv({ X: 'real', A: String.raw`\$X and $X` })).toEqual({
      X: 'real',
      A: '$X and real',
    });
  });
});

describe('expandDotenv — cycles', () => {
  it('detects a direct self-cycle and leaves the raw literal', () => {
    const onWarn = vi.fn();
    const out = expandDotenv({ A: '${A}' }, { onWarn });
    expect(out.A).toBe('${A}');
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toMatch(/cycle/);
  });

  it('detects an indirect cycle', () => {
    const onWarn = vi.fn();
    const out = expandDotenv({ A: '${B}', B: '${A}' }, { onWarn });
    // Both values short-circuit back to their raw literals.
    expect(out.A).toBeTypeOf('string');
    expect(out.B).toBeTypeOf('string');
    expect(onWarn).toHaveBeenCalled();
  });

  it('does not warn when no cycle is present', () => {
    const onWarn = vi.fn();
    expandDotenv({ A: '${B}', B: 'ok' }, { onWarn });
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('expandDotenv — security', () => {
  it('does NOT consult process.env for expansion', () => {
    // A shell env var that isn't in the dotenv record must not leak in.
    const previous = process.env.VOID_DOTENV_EXPAND_TEST;
    process.env.VOID_DOTENV_EXPAND_TEST = 'LEAKED';
    try {
      const out = expandDotenv({ A: '${VOID_DOTENV_EXPAND_TEST}' });
      // Missing refs expand to empty — expressly not the shell value.
      expect(out.A).toBe('');
    } finally {
      if (previous === undefined) {
        delete process.env.VOID_DOTENV_EXPAND_TEST;
      } else {
        process.env.VOID_DOTENV_EXPAND_TEST = previous;
      }
    }
  });
});

describe('scanWranglerDotenvKeys', () => {
  it('reads keys the way Wrangler does, including export and colon forms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'void-dotenv-scan-'));
    const file = join(dir, '.env');
    writeFileSync(
      file,
      [
        '# COMMENTED=1',
        'PLAIN=ok',
        'export EXPORTED=x',
        'COLON: a@b.c',
        'VALUE=has__VOID_inside',
        'MULTI="line one',
        'INSIDE_QUOTES=no"',
        '',
      ].join('\n'),
    );
    expect([...scanWranglerDotenvKeys(file)]).toEqual([
      'PLAIN',
      'EXPORTED',
      'COLON',
      'VALUE',
      'MULTI',
    ]);
  });

  it('returns an empty set for a missing file', () => {
    expect(scanWranglerDotenvKeys('/definitely/not/a/real/path/.env').size).toBe(0);
  });
});
