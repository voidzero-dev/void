import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vite-plus/test';
import { TERMINAL_RENDER_COLUMNS } from '../../src/build-manager.ts';
import { renderCapturedLog } from './log-tail-helpers.ts';

/**
 * Differential test: `renderCapturedLog` must render each captured log
 * line exactly as a real terminal would.
 *
 * The unit tests next door assert specific strings, which only confirm the
 * author's own model of terminal semantics. Here xterm.js (the VT engine VS Code
 * ships) decides what "correct" means.
 *
 * Use the production fixed width. A terminal is a fixed-width grid and wraps at
 * its right margin; sharing one documented width prevents non-painting source
 * bytes from changing semantics and keeps the oracle faithful to deployment.
 */
const COLS = TERMINAL_RENDER_COLUMNS;

/** What a real terminal would be showing after consuming `raw`. */
async function render(raw: string): Promise<string> {
  const term = new Terminal({ cols: COLS, rows: 1, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(raw, resolve));
    const buffer = term.buffer.active;
    return (buffer.getLine(buffer.baseY)?.translateToString(false) ?? '').trimEnd();
  } finally {
    term.dispose();
  }
}

const CASES: Record<string, string> = {
  plain: '[build-agent] source extracted',
  'spinner frames': '◒ Hash (100/281)\x1b[1G\x1b[J◐ Hash (200/281)\x1b[1G\x1b[J◇ Checked',
  'trailing erase after the message': '◆  Deployed!\x1b[1G\x1b[J',
  // A column-1 move with no erase behind it only REPOSITIONS: what follows
  // overwrites from the start and the rest of the row stays on screen. The
  // regex sanitizer treated all four of these as frame boundaries and returned
  // 'Done', dropping 14 visible characters of diagnostic text.
  'bare column-1 move (CHA 1)': 'Downloading assets\x1b[1GDone',
  'bare column-1 move (CHA default)': 'Downloading assets\x1b[GDone',
  'bare column-1 move (CHA 0)': 'Downloading assets\x1b[0GDone',
  'bare CR, no erase': 'Downloading assets\rDone',
  'erase forward (EL0)': 'Downloading\x1b[K done',
  'erase forward explicit (EL0)': 'Downloading\x1b[0K done',
  'erase to cursor (EL1)': 'Downloading\x1b[1K done',
  'erase whole line (EL2)': 'Downloading\x1b[2K done',
  'selective erase whole line (DECSEL 2)': 'SECRET_TOKEN\x1b[?2K\x1b[1GERR',
  'erase display down (ED0)': 'Downloading\x1b[J done',
  'erase display up (ED1)': 'Downloading\x1b[1J done',
  'erase display all (ED2)': 'Downloading\x1b[2J done',
  'selective erase display all (DECSED 2)': 'SECRET_TOKEN\x1b[?2J\x1b[1GERR',
  // ED3 erases scrollback only. The first cell model I wrote folded it into ED2
  // and blanked the row; nothing here caught that, so these four are the case
  // the oracle was missing rather than a case it already covered.
  'erase saved lines (ED3) leaves the row alone': 'Downloading\x1b[3J done',
  'clear-screen combo 2J 3J H': 'Downloading\x1b[2J\x1b[3J\x1b[H done',
  'clear-screen combo 3J H 2J': 'Downloading\x1b[3J\x1b[H\x1b[2J done',
  'clear-screen combo H 2J 3J': 'Downloading\x1b[H\x1b[2J\x1b[3J done',
  'partial column move': 'Downloading\x1b[5G done',
  'cursor forward': 'ab\x1b[3Ccd',
  'cursor back': 'abcdef\x1b[3Dxy',
  backspace: 'abcdef\b\bxy',
  // DEL is a control byte, not a printable cell. Painting it also advances the
  // modeled cursor and makes a following backspace overwrite the wrong column.
  'DEL is ignored': 'ab\x7f\bX',
  'SGR color': '\x1b[32m✓\x1b[0m building client + server bundles...',
  'colon-form truecolor SGR': '\x1b[38:2::255:0:0mRED\x1b[0m done',
  'private CSI': '\x1b[>4;2mtext',
  'DEC cursor hide/show': '\x1b[?25l│\x1b[?25h',
  'OSC with BEL': '\x1b]0;building\x07done',
  'OSC with ST': '\x1b]8;;https://void.app\x1b\\link',
  'APC payload (kitty graphics)': 'before\x1b_Gf=100,a=T;PAYLOAD\x1b\\after',
  'DCS payload (sixel)': 'before\x1bPq#0;2;0;0;0PAYLOAD\x1b\\after',
  'BEL inside DCS does not terminate': 'a\x1bPq hidden\x07 still-hidden\x1b\\b',
  // xterm aborts a string control on a bare ESC and starts a new sequence;
  // swallowing to ST instead eats every remaining visible cell on the row.
  'embedded ESC aborts APC': 'a\x1b_Gpayload\x1b[0mmoretail',
  'embedded ESC aborts DCS': 'a\x1bPq payload\x1b[0mmoretail',
  'CAN aborts APC': 'before\x1b_hidden\x18after',
  'SUB aborts DCS': 'before\x1bPhidden\x1aafter',
  'BEL executes without terminating CSI': 'SECRET_TOKEN\x1b[2\x07K\x1b[1GERR',
  'BS executes without terminating CSI': 'abc\x1b[\b31mX',
  'CAN cancels CSI': 'abc\x1b[2\x18K',
  'ESC aborts CSI and starts a new escape': 'SECRET_TOKEN\x1b[2\x1b[2K\x1b[1GERR',
  'CR executes without terminating ESC': 'SECRET\x1b\rc failed',
  'CR executes before DECSC': 'abc\x1b\r7X',
  'BEL executes inside ESC intermediates': 'a\x1b(\x07Bb',
  'BEL executes before a CSI introducer': 'SECRET_TOKEN\x1b\x07[2K\x1b[1GERR',
  'BEL executes before an OSC introducer': 'before\x1b\x07]0;hidden\x07after',
  'CAN cancels ESC': 'abc\x1b\x18c',
  'ESC aborts ESC and starts a new escape': 'SECRET\x1b\r\x1bcvisible',
  'unterminated CSI': 'text\x1b[',
  'lone ESC at end': 'text\x1b',
  'literal text that looks like an escape': 'cost [32m] and \\x1b are literal',
  'CUP row;col': 'Downloading\x1b[1;5H done',
  'CNL resets the cursor column': 'SECRET\x1b[E\x1b[KERR',
  'CPL resets the cursor column': 'SECRET\x1b[F\x1b[KERR',
  'HPA sets the absolute column': 'SECRET\x1b[1`\x1b[KERR',
  'HPR advances the cursor': 'SECRET\x1b[6D\x1b[6a\x1b[1K\x1b[1GERR',
  'CHT advances by tab stops': 'SECRET\x1b[6D\x1b[I\x1b[1K\x1b[1GERR',
  'CBT retreats by tab stops': 'SECRET\x1b[Z\x1b[K\x1b[1GERR',
  'configured tab stops drive repaint': 'SECRET_TOKEN_ABCDEFG\x1b[3g\x1bH\r\t\x1b[1K\x1b[1GERR',
  'HTS supplies a custom HT destination': 'abcde\x1b[3g\x1bH\r\tX',
  'configured stops drive CHT': 'abc\x1b[3g\x1bHde\x1bH\r\x1b[2IX',
  'configured stops drive CBT': 'abc\x1b[3g\x1bHde\x1bHfghij\x1b[2ZX',
  'TBC clears the current default stop': '12345678\x1b[g\r\tX',
  '8-bit HTS sets a stop': 'abcdef\u0088\r\tX',

  // HT moves to the next tab stop, it does not paint. Treating it as one glyph
  // desynchronised every cursor move after it.
  'tab advances to a tab stop': 'ab\tcd',
  'tab at a stop boundary': 'abcdefgh\tX',
  'tab then column move': 'a\tb\x1b[3GZ',
  'many tabs': '\t\t\tx',
  // ECH erases in place without moving the cursor; dropping it resurrected text
  // the terminal had blanked.
  'ECH erases in place': 'TOKEN\x1b[5D\x1b[5X',
  'ECH partial': 'abcdef\x1b[3D\x1b[2X',
  'ECH default param': 'abcdef\x1b[3D\x1b[X',
  'ECH past end of row': 'abc\x1b[99X done',
  // DCH/ICH SHIFT cells rather than blanking them. Left in the default branch,
  // DCH resurrected text the terminal had removed — the same class as ECH.
  'DCH deletes and shifts left': 'TOKEN\x1b[5D\x1b[5P',
  'DCH partial': 'abcdef\x1b[6D\x1b[2P',
  'DCH default param': 'abcdef\x1b[6D\x1b[P',
  'DCH past end of row': 'abc\x1b[3D\x1b[99P tail',
  'ICH inserts blanks': 'abcdef\x1b[3D\x1b[2@',
  'ICH default param': 'abcdef\x1b[3D\x1b[@',
  'DCH then write': 'abcdef\x1b[6D\x1b[3PXY',
  // Intermediate bytes are part of the command identity: `SP @`/`SP A` are
  // Scroll Left/Right, not bare ICH/CUU commands that happen to share a final.
  'SL shifts the row left': 'SECRET\x1b[1G\x1b[3 @\x1b[1GERR',
  'SR shifts the row right': 'SECRET\x1b[1G\x1b[3 A\x1b[1GERR',
  'DECIC inserts columns': "SECRET\x1b[1G\x1b[3'}\x1b[1GERR",
  'DECDC deletes columns': "SECRET\x1b[1G\x1b[3'~\x1b[1GERR",
  'DECSTR resets the saved cursor': 'abc\x1b7\x1b[1GX\x1b[!p\x1b8Y',
  'unknown intermediate does not alias ICH': 'SECRET\x1b[1G\x1b[3!@\x1b[1GERR',
  // DECSC/DECRC and their SCO equivalents. Treated as inert, a restore was
  // silently dropped and the following text landed at the wrong column.
  'DECSC/DECRC': 'abc\x1b7\x1b[1GX\x1b8Y',
  'DECRC with no save': 'abc\x1b8X',
  'SCOSC/SCORC (CSI s/u)': 'abc\x1bs\x1b[1GX\x1buY'
    .replace('\x1bs', '\x1b[s')
    .replace('\x1bu', '\x1b[u'),
  'DECSC then erase': 'abcdef\x1b7\x1b[1G\x1b[K\x1b8X',
  // ICH must shift within the row, not grow it without bound.
  'ICH at column 0': 'abc\x1b[3D\x1b[2@',
  'ICH large count': 'abcdef\x1b[3D\x1b[40@X',
  'ICH repeated': 'abcdef\x1b[6D\x1b[4@\x1b[4@\x1b[4@Z',
  'REP paints repeated ASCII': 'SECRET\rX\x1b[5b',
  'REP is invalidated by another CSI': 'SECRET\rX\x1b[31m\x1b[5b',

  // DECSCA marks subsequently written cells as protected. DECSEL/DECSED respect
  // that bit; ordinary erase still clears every cell.
  'DECSED preserves protected cells': '\x1b[1"qSECRET\x1b[?2K',
  'DECSED clears only unprotected cells': 'A\x1b[1"qBC\x1b[0"qDE\x1b[1G\x1b[?2K',
  'ordinary ED clears protected cells': '\x1b[1"qSECRET\x1b[2K',
  'SGR0 resets protection': '\x1b[1"qA\x1b[0mB\x1b[?2K',

  // A cell holds a GRAPHEME. Stepping by UTF-16 code unit split astral emoji
  // across two cells, so any move/erase landing between the halves emitted a
  // lone surrogate (U+FFFD on GitHub); combining marks stole a column they do
  // not occupy; and CJK/emoji took one column instead of two, so every later
  // absolute column move landed on the wrong cell.
  'combining mark + backspace': 'e\u0301\bX',
  'combining mark, no move': 'e\u0301 done',
  'combining mark with nothing to its left': '\u0301abc',
  'astral emoji, undisturbed': 'build \u{1F600} ok',
  'astral emoji + CUB into it': 'a\u{1F600}\x1b[1Db',
  'astral emoji + column move into it': '\u{1F600}\x1b[2GX',
  'astral emoji + erase forward': '\u{1F600}\x1b[K done',
  'astral emoji + erase to cursor': '\u{1F600}ab\x1b[1K done',
  'wide CJK + column move': '\u4e2d\u6587\x1b[3GX',
  'wide CJK, undisturbed': '\u4e2d\u6587 done',
  'wide CJK + backspace': '\u4e2d\u6587\bX',
  'fullwidth forms': '\uff21\uff22\x1b[2GX',
  'ZWJ emoji sequence': '\u{1F468}\u200D\u{1F4BB} built',
  'emoji then CR overwrite': '\u{1F600}\u{1F600}\rok',
  // A mark following a WIDE glyph belongs on the glyph, not on its continuation
  // marker. Appending to the marker also destroyed the sentinel `splitWideAt`
  // reads, so a later write into the trailing half kept a glyph xterm discards.
  'combining mark on a wide glyph': '\u4E2D\u0301X',
  'combining mark on a wide glyph + backspace': '\u4E2D\u0301\bX',
  'combining mark on a fullwidth glyph + column move': '\uFF21\u0301\x1b[2GX',
  'decomposed Hangul Jamo + column move': '\u1100\u1161\x1b[3GX',

  // 8-bit C1 controls: the single-code-point form of `ESC <char>`. Build output
  // is decoded text, so these arrive as real code points; matching only the
  // 7-bit forms leaked whole sequences \u2014 and entire DCS/APC payloads \u2014 as text.
  '8-bit CSI (U+009B)': 'Downloading\u009B1GDone',
  '8-bit CSI erase': 'Downloading\u009BK done',
  '8-bit APC payload, ST-terminated': 'before\u009Fpayload\u009Cafter',
  '8-bit OSC payload': 'before\u009D0;title\u009Cafter',
  '8-bit DCS payload': 'before\u0090q\u009Cafter',
  '8-bit CSI aborts a DCS payload': 'before\x1bPq\u009B1GHIDDEN\x1b\\after',
  '8-bit and 7-bit mixed': 'a\u009B2Cb\x1b[1GX',

  // ESC <intermediates 0x20-0x2F> <final>. Assuming two bytes printed the final
  // byte of terminfo's `sgr0` (`ESC ( B`) into every colourised build's tail.
  'ESC ( B charset reset (terminfo sgr0)': 'red\x1b(B\x1b[mplain',
  'ESC ) 0 charset designation': 'a\x1b)0b',
  'ESC % G utf-8 designation': 'a\x1b%Gb',
  'ESC ( B then column move': 'abc\x1b(B\x1b[1GX',

  // RIS. Dropping it would resurrect content the terminal had explicitly
  // cleared, like ignoring ECH.
  'RIS clears the row': 'TOKEN\x1bc failed',
  'RIS then text': 'secret\x1bcvisible',
  'RIS resets the saved cursor': 'abcdef\x1b7\x1bcX\x1b8Y',

  // A WIDE write covers two columns, so the glyph it orphans may start at the
  // second one. Clearing only at the cursor would leave a stray continuation
  // marker that later reads as "inside a glyph".
  'wide write orphans a wide head one column on': ' 中\x1b[1G中\x1b[3GX',
  'wide write lands exactly on a wide glyph': '中中\x1b[1G中X',
  'wide write over a narrow then wide': 'a中\x1b[1G中\x1b[3GX',

  // SU/SD scroll the only row we model out of view. Falling through as
  // non-painting resurrected content the terminal had scrolled away.
  'scroll up (SU) blanks the row': 'SECRET_TOKEN\x1b[S\x1b[1GERR',
  'scroll up explicit count': 'SECRET_TOKEN\x1b[2S\x1b[1GERR',
  'scroll down (SD) blanks the row': 'SECRET_TOKEN\x1b[T\x1b[1GERR',
  'scroll up leaves the cursor put': 'SECRET_TOKEN\x1b[S done',

  // In a one-row terminal IL/DL replace the only modeled row with blanks. The
  // same is true when a vertical motion scrolls beyond the sole top/bottom row.
  'insert line (IL) blanks the row': 'SECRET_TOKEN\x1b[L\x1b[1GERR',
  'delete line (DL) blanks the row': 'SECRET_TOKEN\x1b[M\x1b[1GERR',
  'index (IND) blanks the row': 'SECRET_TOKEN\x1bD\x1b[1GERR',
  'next line (NEL) blanks the row and returns to column 1': 'SECRET_TOKEN\x1bEERR',
  'reverse index (RI) blanks the row': 'SECRET_TOKEN\x1bM\x1b[1GERR',
  '8-bit next line (NEL) blanks the row': 'SECRET_TOKEN\u0085ERR',
  'vertical tab blanks the row': 'SECRET_TOKEN\v\x1b[1GERR',
  'form feed blanks the row': 'SECRET_TOKEN\f\x1b[1GERR',
};

describe('renderCapturedLog matches a real terminal (xterm.js oracle)', () => {
  for (const [name, raw] of Object.entries(CASES)) {
    it.concurrent(name, async () => {
      const [actual, expected] = await Promise.all([renderCapturedLog(raw), render(raw)]);
      expect(actual).toBe(expected);
    });
  }

  // xterm defers writes through timers. Overlap independent comparisons in eight
  // lanes; each lane owns and resets its terminal, with real timers throughout.
  it('agrees on randomly generated escape soup', async () => {
    const atoms = [
      'a',
      'bc',
      'Downloading',
      ' ',
      '\r',
      '\b',
      '\x1b[G',
      '\x1b[1G',
      '\x1b[0G',
      '\x1b[4G',
      '\x1b[2C',
      '\x1b[2D',
      '\x1b[K',
      '\x1b[0K',
      '\x1b[1K',
      '\x1b[2K',
      '\x1b[J',
      '\x1b[1J',
      '\x1b[2J',
      '\x1b[3J',
      '\x1b[H',
      '\x1b[5C',
      '\x1b[32m',
      '\x1b[0m',
      '\x1b[?25l',
      '\x1b[38:2::0:255:0m',
      '\x1b]0;t\x07',
      '\x1b_G;p\x1b\\',
      '\x1b[1;3H',
      '\t',
      '\x1b[3X',
      '\x1b[2P',
      '\x1b[P',
      '\x1b[2@',
      '\x1b[3 @',
      '\x1b[3 A',
      "\x1b[3'}",
      "\x1b[3'~",
      '\x1b[!p',
      '\x1b[3!@',
      '\x1b[1"q',
      '\x1b[0"q',
      '\x1b[?2K',
      '\x1b[3g',
      '\x1bH',
      '\x1b[g',
      '\x1b[2I',
      '\x1b[2Z',
      '\x1b[4b',
      '\x1b7',
      '\x1b8',
      '\x1b[s',
      '\x1b[u',
      '\x1b[X',
      '\u{1F600}',
      '\u4e2d',
      'e\u0301',
      '\uff21',
      '\u4e2d\u0301',
      '\u009b1G',
      '\u009bK',
      '\u009f p \u009c',
      '\x1b(B',
      '\x1bc',
      '\x1b[S',
      '\x1b[T',
      '\x1b[2S',
    ];

    const inputs = new Set<string>();
    const generate = (length: number, rand: (n: number) => number) => {
      let raw = '';
      for (let j = 0; j < length; j++) {
        raw += atoms[rand(atoms.length)];
      }
      inputs.add(raw);
    };
    // Preserve every input from the original regression corpus. Its floating
    // point LCG produced 691 distinct strings from 900 iterations, almost all
    // with lengths 1, 5 or 9. Rechecking duplicates adds no independent coverage.
    let legacySeed = 0x2f6e2b1;
    const legacyRand = (n: number): number => {
      legacySeed = (legacySeed * 1103515245 + 12345) & 0x7fffffff;
      return legacySeed % n;
    };
    for (let i = 0; i < 900; i++) {
      generate(1 + legacyRand(12), legacyRand);
    }
    expect(inputs.size).toBe(691);

    // Replace the 209 duplicate inputs with deterministic xorshift32 cases.
    // Cycle lengths explicitly so all lengths 1..12 are exercised.
    let seed = 0x2f6e2b1;
    const rand = (n: number): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    for (let i = 0; inputs.size < 900; i++) {
      generate(2 + (i % 11), rand);
    }
    const corpus = [...inputs];
    const lanes = Array.from({ length: 8 }, async (_, lane) => {
      const term = new Terminal({ cols: COLS, rows: 1, allowProposedApi: true });
      try {
        for (let index = lane; index < corpus.length; index += 8) {
          const raw = corpus[index]!;
          term.reset();
          const [actual] = await Promise.all([
            renderCapturedLog(raw),
            new Promise<void>((resolve) => term.write(raw, resolve)),
          ]);
          const buffer = term.buffer.active;
          const expected = (buffer.getLine(buffer.baseY)?.translateToString(false) ?? '').trimEnd();
          expect(actual, JSON.stringify(raw)).toBe(expected);
        }
      } finally {
        term.dispose();
      }
    });
    // Drain every lane before reporting failure, so no terminal work leaks into
    // another test when one comparison fails.
    const results = await Promise.allSettled(lanes);
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
  }, 60_000);
});
