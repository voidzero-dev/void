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
    await new Promise<void>((resolve) => {
      term.write(raw, resolve);
    });
    const buffer = term.buffer.active;
    return (buffer.getLine(buffer.baseY)?.translateToString(false) ?? '').trimEnd();
  } finally {
    term.dispose();
  }
}

const CASES: Record<string, string> = {
  plain: '[build-agent] source extracted',
  'spinner frames': '◒ Hash (100/281)\u001b[1G\u001b[J◐ Hash (200/281)\u001b[1G\u001b[J◇ Checked',
  'trailing erase after the message': '◆  Deployed!\u001b[1G\u001b[J',
  // A column-1 move with no erase behind it only REPOSITIONS: what follows
  // overwrites from the start and the rest of the row stays on screen. The
  // regex sanitizer treated all four of these as frame boundaries and returned
  // 'Done', dropping 14 visible characters of diagnostic text.
  'bare column-1 move (CHA 1)': 'Downloading assets\u001b[1GDone',
  'bare column-1 move (CHA default)': 'Downloading assets\u001b[GDone',
  'bare column-1 move (CHA 0)': 'Downloading assets\u001b[0GDone',
  'bare CR, no erase': 'Downloading assets\rDone',
  'erase forward (EL0)': 'Downloading\u001b[K done',
  'erase forward explicit (EL0)': 'Downloading\u001b[0K done',
  'erase to cursor (EL1)': 'Downloading\u001b[1K done',
  'erase whole line (EL2)': 'Downloading\u001b[2K done',
  'selective erase whole line (DECSEL 2)': 'SECRET_TOKEN\u001b[?2K\u001b[1GERR',
  'erase display down (ED0)': 'Downloading\u001b[J done',
  'erase display up (ED1)': 'Downloading\u001b[1J done',
  'erase display all (ED2)': 'Downloading\u001b[2J done',
  'selective erase display all (DECSED 2)': 'SECRET_TOKEN\u001b[?2J\u001b[1GERR',
  // ED3 erases scrollback only. The first cell model I wrote folded it into ED2
  // and blanked the row; nothing here caught that, so these four are the case
  // the oracle was missing rather than a case it already covered.
  'erase saved lines (ED3) leaves the row alone': 'Downloading\u001b[3J done',
  'clear-screen combo 2J 3J H': 'Downloading\u001b[2J\u001b[3J\u001b[H done',
  'clear-screen combo 3J H 2J': 'Downloading\u001b[3J\u001b[H\u001b[2J done',
  'clear-screen combo H 2J 3J': 'Downloading\u001b[H\u001b[2J\u001b[3J done',
  'partial column move': 'Downloading\u001b[5G done',
  'cursor forward': 'ab\u001b[3Ccd',
  'cursor back': 'abcdef\u001b[3Dxy',
  backspace: 'abcdef\b\bxy',
  // DEL is a control byte, not a printable cell. Painting it also advances the
  // modeled cursor and makes a following backspace overwrite the wrong column.
  'DEL is ignored': 'ab\u007f\bX',
  'SGR color': '\u001b[32m✓\u001b[0m building client + server bundles...',
  'colon-form truecolor SGR': '\u001b[38:2::255:0:0mRED\u001b[0m done',
  'private CSI': '\u001b[>4;2mtext',
  'DEC cursor hide/show': '\u001b[?25l│\u001b[?25h',
  'OSC with BEL': '\u001b]0;building\u0007done',
  'OSC with ST': '\u001b]8;;https://void.app\u001b\\link',
  'APC payload (kitty graphics)': 'before\u001b_Gf=100,a=T;PAYLOAD\u001b\\after',
  'DCS payload (sixel)': 'before\u001bPq#0;2;0;0;0PAYLOAD\u001b\\after',
  'BEL inside DCS does not terminate': 'a\u001bPq hidden\u0007 still-hidden\u001b\\b',
  // xterm aborts a string control on a bare ESC and starts a new sequence;
  // swallowing to ST instead eats every remaining visible cell on the row.
  'embedded ESC aborts APC': 'a\u001b_Gpayload\u001b[0mmoretail',
  'embedded ESC aborts DCS': 'a\u001bPq payload\u001b[0mmoretail',
  'CAN aborts APC': 'before\u001b_hidden\u0018after',
  'SUB aborts DCS': 'before\u001bPhidden\u001aafter',
  'BEL executes without terminating CSI': 'SECRET_TOKEN\u001b[2\u0007K\u001b[1GERR',
  'BS executes without terminating CSI': 'abc\u001b[\b31mX',
  'CAN cancels CSI': 'abc\u001b[2\u0018K',
  'ESC aborts CSI and starts a new escape': 'SECRET_TOKEN\u001b[2\u001b[2K\u001b[1GERR',
  'CR executes without terminating ESC': 'SECRET\u001b\rc failed',
  'CR executes before DECSC': 'abc\u001b\r7X',
  'BEL executes inside ESC intermediates': 'a\u001b(\u0007Bb',
  'BEL executes before a CSI introducer': 'SECRET_TOKEN\u001b\u0007[2K\u001b[1GERR',
  'BEL executes before an OSC introducer': 'before\u001b\u0007]0;hidden\u0007after',
  'CAN cancels ESC': 'abc\u001b\u0018c',
  'ESC aborts ESC and starts a new escape': 'SECRET\u001b\r\u001bcvisible',
  'unterminated CSI': 'text\u001b[',
  'lone ESC at end': 'text\u001b',
  'literal text that looks like an escape': String.raw`cost [32m] and \x1b are literal`,
  'CUP row;col': 'Downloading\u001b[1;5H done',
  'CNL resets the cursor column': 'SECRET\u001b[E\u001b[KERR',
  'CPL resets the cursor column': 'SECRET\u001b[F\u001b[KERR',
  'HPA sets the absolute column': 'SECRET\u001b[1`\u001b[KERR',
  'HPR advances the cursor': 'SECRET\u001b[6D\u001b[6a\u001b[1K\u001b[1GERR',
  'CHT advances by tab stops': 'SECRET\u001b[6D\u001b[I\u001b[1K\u001b[1GERR',
  'CBT retreats by tab stops': 'SECRET\u001b[Z\u001b[K\u001b[1GERR',
  'configured tab stops drive repaint':
    'SECRET_TOKEN_ABCDEFG\u001b[3g\u001bH\r\t\u001b[1K\u001b[1GERR',
  'HTS supplies a custom HT destination': 'abcde\u001b[3g\u001bH\r\tX',
  'configured stops drive CHT': 'abc\u001b[3g\u001bHde\u001bH\r\u001b[2IX',
  'configured stops drive CBT': 'abc\u001b[3g\u001bHde\u001bHfghij\u001b[2ZX',
  'TBC clears the current default stop': '12345678\u001b[g\r\tX',
  '8-bit HTS sets a stop': 'abcdef\u0088\r\tX',

  // HT moves to the next tab stop, it does not paint. Treating it as one glyph
  // desynchronised every cursor move after it.
  'tab advances to a tab stop': 'ab\tcd',
  'tab at a stop boundary': 'abcdefgh\tX',
  'tab then column move': 'a\tb\u001b[3GZ',
  'many tabs': '\t\t\tx',
  // ECH erases in place without moving the cursor; dropping it resurrected text
  // the terminal had blanked.
  'ECH erases in place': 'TOKEN\u001b[5D\u001b[5X',
  'ECH partial': 'abcdef\u001b[3D\u001b[2X',
  'ECH default param': 'abcdef\u001b[3D\u001b[X',
  'ECH past end of row': 'abc\u001b[99X done',
  // DCH/ICH SHIFT cells rather than blanking them. Left in the default branch,
  // DCH resurrected text the terminal had removed — the same class as ECH.
  'DCH deletes and shifts left': 'TOKEN\u001b[5D\u001b[5P',
  'DCH partial': 'abcdef\u001b[6D\u001b[2P',
  'DCH default param': 'abcdef\u001b[6D\u001b[P',
  'DCH past end of row': 'abc\u001b[3D\u001b[99P tail',
  'ICH inserts blanks': 'abcdef\u001b[3D\u001b[2@',
  'ICH default param': 'abcdef\u001b[3D\u001b[@',
  'DCH then write': 'abcdef\u001b[6D\u001b[3PXY',
  // Intermediate bytes are part of the command identity: `SP @`/`SP A` are
  // Scroll Left/Right, not bare ICH/CUU commands that happen to share a final.
  'SL shifts the row left': 'SECRET\u001b[1G\u001b[3 @\u001b[1GERR',
  'SR shifts the row right': 'SECRET\u001b[1G\u001b[3 A\u001b[1GERR',
  'DECIC inserts columns': "SECRET\u001b[1G\u001b[3'}\u001b[1GERR",
  'DECDC deletes columns': "SECRET\u001b[1G\u001b[3'~\u001b[1GERR",
  'DECSTR resets the saved cursor': 'abc\u001b7\u001b[1GX\u001b[!p\u001b8Y',
  'unknown intermediate does not alias ICH': 'SECRET\u001b[1G\u001b[3!@\u001b[1GERR',
  // DECSC/DECRC and their SCO equivalents. Treated as inert, a restore was
  // silently dropped and the following text landed at the wrong column.
  'DECSC/DECRC': 'abc\u001b7\u001b[1GX\u001b8Y',
  'DECRC with no save': 'abc\u001b8X',
  'SCOSC/SCORC (CSI s/u)': 'abc\u001bs\u001b[1GX\u001buY'
    .replace('\u001bs', '\u001b[s')
    .replace('\u001bu', '\u001b[u'),
  'DECSC then erase': 'abcdef\u001b7\u001b[1G\u001b[K\u001b8X',
  // ICH must shift within the row, not grow it without bound.
  'ICH at column 0': 'abc\u001b[3D\u001b[2@',
  'ICH large count': 'abcdef\u001b[3D\u001b[40@X',
  'ICH repeated': 'abcdef\u001b[6D\u001b[4@\u001b[4@\u001b[4@Z',
  'REP paints repeated ASCII': 'SECRET\rX\u001b[5b',
  'REP is invalidated by another CSI': 'SECRET\rX\u001b[31m\u001b[5b',

  // DECSCA marks subsequently written cells as protected. DECSEL/DECSED respect
  // that bit; ordinary erase still clears every cell.
  'DECSED preserves protected cells': '\u001b[1"qSECRET\u001b[?2K',
  'DECSED clears only unprotected cells': 'A\u001b[1"qBC\u001b[0"qDE\u001b[1G\u001b[?2K',
  'ordinary ED clears protected cells': '\u001b[1"qSECRET\u001b[2K',
  'SGR0 resets protection': '\u001b[1"qA\u001b[0mB\u001b[?2K',

  // A cell holds a GRAPHEME. Stepping by UTF-16 code unit split astral emoji
  // across two cells, so any move/erase landing between the halves emitted a
  // lone surrogate (U+FFFD on GitHub); combining marks stole a column they do
  // not occupy; and CJK/emoji took one column instead of two, so every later
  // absolute column move landed on the wrong cell.
  'combining mark + backspace': 'e\u0301\bX',
  'combining mark, no move': 'e\u0301 done',
  'combining mark with nothing to its left': '\u0301abc',
  'astral emoji, undisturbed': 'build \u{1F600} ok',
  'astral emoji + CUB into it': 'a\u{1F600}\u001b[1Db',
  'astral emoji + column move into it': '\u{1F600}\u001b[2GX',
  'astral emoji + erase forward': '\u{1F600}\u001b[K done',
  'astral emoji + erase to cursor': '\u{1F600}ab\u001b[1K done',
  'wide CJK + column move': '\u4e2d\u6587\u001b[3GX',
  'wide CJK, undisturbed': '\u4e2d\u6587 done',
  'wide CJK + backspace': '\u4e2d\u6587\bX',
  'fullwidth forms': '\uff21\uff22\u001b[2GX',
  'ZWJ emoji sequence': '\u{1F468}\u200D\u{1F4BB} built',
  'emoji then CR overwrite': '\u{1F600}\u{1F600}\rok',
  // A mark following a WIDE glyph belongs on the glyph, not on its continuation
  // marker. Appending to the marker also destroyed the sentinel `splitWideAt`
  // reads, so a later write into the trailing half kept a glyph xterm discards.
  'combining mark on a wide glyph': '\u4E2D\u0301X',
  'combining mark on a wide glyph + backspace': '\u4E2D\u0301\bX',
  'combining mark on a fullwidth glyph + column move': '\uFF21\u0301\u001b[2GX',
  'decomposed Hangul Jamo + column move': '\u1100\u1161\u001b[3GX',

  // 8-bit C1 controls: the single-code-point form of `ESC <char>`. Build output
  // is decoded text, so these arrive as real code points; matching only the
  // 7-bit forms leaked whole sequences \u2014 and entire DCS/APC payloads \u2014 as text.
  '8-bit CSI (U+009B)': 'Downloading\u009B1GDone',
  '8-bit CSI erase': 'Downloading\u009BK done',
  '8-bit APC payload, ST-terminated': 'before\u009Fpayload\u009Cafter',
  '8-bit OSC payload': 'before\u009D0;title\u009Cafter',
  '8-bit DCS payload': 'before\u0090q\u009Cafter',
  '8-bit CSI aborts a DCS payload': 'before\u001bPq\u009B1GHIDDEN\u001b\\after',
  '8-bit and 7-bit mixed': 'a\u009B2Cb\u001b[1GX',

  // ESC <intermediates 0x20-0x2F> <final>. Assuming two bytes printed the final
  // byte of terminfo's `sgr0` (`ESC ( B`) into every colourised build's tail.
  'ESC ( B charset reset (terminfo sgr0)': 'red\u001b(B\u001b[mplain',
  'ESC ) 0 charset designation': 'a\u001b)0b',
  'ESC % G utf-8 designation': 'a\u001b%Gb',
  'ESC ( B then column move': 'abc\u001b(B\u001b[1GX',

  // RIS. Dropping it would resurrect content the terminal had explicitly
  // cleared, like ignoring ECH.
  'RIS clears the row': 'TOKEN\u001bc failed',
  'RIS then text': 'secret\u001bcvisible',
  'RIS resets the saved cursor': 'abcdef\u001b7\u001bcX\u001b8Y',

  // A WIDE write covers two columns, so the glyph it orphans may start at the
  // second one. Clearing only at the cursor would leave a stray continuation
  // marker that later reads as "inside a glyph".
  'wide write orphans a wide head one column on': ' 中\u001b[1G中\u001b[3GX',
  'wide write lands exactly on a wide glyph': '中中\u001b[1G中X',
  'wide write over a narrow then wide': 'a中\u001b[1G中\u001b[3GX',

  // SU/SD scroll the only row we model out of view. Falling through as
  // non-painting resurrected content the terminal had scrolled away.
  'scroll up (SU) blanks the row': 'SECRET_TOKEN\u001b[S\u001b[1GERR',
  'scroll up explicit count': 'SECRET_TOKEN\u001b[2S\u001b[1GERR',
  'scroll down (SD) blanks the row': 'SECRET_TOKEN\u001b[T\u001b[1GERR',
  'scroll up leaves the cursor put': 'SECRET_TOKEN\u001b[S done',

  // In a one-row terminal IL/DL replace the only modeled row with blanks. The
  // same is true when a vertical motion scrolls beyond the sole top/bottom row.
  'insert line (IL) blanks the row': 'SECRET_TOKEN\u001b[L\u001b[1GERR',
  'delete line (DL) blanks the row': 'SECRET_TOKEN\u001b[M\u001b[1GERR',
  'index (IND) blanks the row': 'SECRET_TOKEN\u001bD\u001b[1GERR',
  'next line (NEL) blanks the row and returns to column 1': 'SECRET_TOKEN\u001bEERR',
  'reverse index (RI) blanks the row': 'SECRET_TOKEN\u001bM\u001b[1GERR',
  '8-bit next line (NEL) blanks the row': 'SECRET_TOKEN\u0085ERR',
  'vertical tab blanks the row': 'SECRET_TOKEN\v\u001b[1GERR',
  'form feed blanks the row': 'SECRET_TOKEN\f\u001b[1GERR',
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
      '\u001b[G',
      '\u001b[1G',
      '\u001b[0G',
      '\u001b[4G',
      '\u001b[2C',
      '\u001b[2D',
      '\u001b[K',
      '\u001b[0K',
      '\u001b[1K',
      '\u001b[2K',
      '\u001b[J',
      '\u001b[1J',
      '\u001b[2J',
      '\u001b[3J',
      '\u001b[H',
      '\u001b[5C',
      '\u001b[32m',
      '\u001b[0m',
      '\u001b[?25l',
      '\u001b[38:2::0:255:0m',
      '\u001b]0;t\u0007',
      '\u001b_G;p\u001b\\',
      '\u001b[1;3H',
      '\t',
      '\u001b[3X',
      '\u001b[2P',
      '\u001b[P',
      '\u001b[2@',
      '\u001b[3 @',
      '\u001b[3 A',
      "\u001b[3'}",
      "\u001b[3'~",
      '\u001b[!p',
      '\u001b[3!@',
      '\u001b[1"q',
      '\u001b[0"q',
      '\u001b[?2K',
      '\u001b[3g',
      '\u001bH',
      '\u001b[g',
      '\u001b[2I',
      '\u001b[2Z',
      '\u001b[4b',
      '\u001b7',
      '\u001b8',
      '\u001b[s',
      '\u001b[u',
      '\u001b[X',
      '\u{1F600}',
      '\u4e2d',
      'e\u0301',
      '\uff21',
      '\u4e2d\u0301',
      '\u009b1G',
      '\u009bK',
      '\u009f p \u009c',
      '\u001b(B',
      '\u001bc',
      '\u001b[S',
      '\u001b[T',
      '\u001b[2S',
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
    let legacySeed = 0x2_f6_e2_b1;
    const legacyRand = (n: number): number => {
      legacySeed = (legacySeed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return legacySeed % n;
    };
    for (let i = 0; i < 900; i++) {
      generate(1 + legacyRand(12), legacyRand);
    }
    expect(inputs.size).toBe(691);

    // Replace the 209 duplicate inputs with deterministic xorshift32 cases.
    // Cycle lengths explicitly so all lengths 1..12 are exercised.
    let seed = 0x2_f6_e2_b1;
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
            new Promise<void>((resolve) => {
              term.write(raw, resolve);
            }),
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
