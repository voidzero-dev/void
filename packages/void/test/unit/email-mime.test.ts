import { describe, expect, it } from 'vite-plus/test';
import {
  buildMime,
  MAX_ADDRESS_LENGTH,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  MimeError,
  normalizeEmail,
  parseAddress,
} from '../../src/runtime/email/mime.ts';
import type { Attachment } from '../../src/runtime/email/types.ts';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * The one shape message `validateAddressParts` throws: the rule is
 * `email-validator`, and the message names the rule rather than echoing the
 * address (which may hold a control character).
 */
function invalidAddress(field: string): string {
  return (
    `${field}: address is not a valid email address (ASCII local part and dotted domain, ` +
    `RFC 5322 dot-atom; at most 64 characters before the '@' and 254 in total).`
  );
}

async function build(opts: Parameters<typeof normalizeEmail>[0]) {
  const email = await normalizeEmail(opts);
  const { raw, messageId } = buildMime(email);
  return { raw, messageId, text: decode(raw) };
}

type Threading = Parameters<typeof buildMime>[0]['threading'];

/**
 * `normalizeEmail` caps threading ids, so size checks that need a larger
 * value hand them to `buildMime` directly: it is the authority on the size.
 */
async function normalizeWithThreading(
  opts: Parameters<typeof normalizeEmail>[0],
  threading: Threading,
): Promise<Parameters<typeof buildMime>[0]> {
  return { ...(await normalizeEmail(opts)), threading };
}

function b64ToText(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Collect one header's physical lines: the `Name:` line plus every
 * continuation (a line starting with WSP — RFC 5322 §2.2.3 folding).
 */
function headerLines(text: string, name: string): Array<string> {
  const lines = text.split('\r\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (start < 0) {
    throw new Error(`header '${name}' not found`);
  }
  const collected = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith(' ') || lines[i].startsWith('\t')) {
      collected.push(lines[i]);
    } else {
      break;
    }
  }
  return collected;
}

/** RFC 5322 §2.2.3 unfolding: drop the CRLF, keep the leading WSP. */
function unfoldHeader(text: string, name: string): string {
  return headerLines(text, name).join('').slice(`${name}:`.length).trimStart();
}

/** Every encoded-word in a value, as raw `=?UTF-8?B?...?=` strings. */
function encodedWords(value: string): Array<string> {
  return value.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=/g) ?? [];
}

/**
 * Independent RFC 2047 decoder used as an in-test oracle. Per §6.2 the
 * linear whitespace separating two *adjacent* encoded-words is dropped
 * while whitespace next to ordinary text is kept. Each word is
 * base64-decoded on its own, which is only correct because §5 forbids
 * splitting a character across adjacent encoded-words — so this also
 * proves the chunker never cut a multi-octet character in half.
 */
function decodeEncodedWords(value: string): string {
  let out = '';
  let last = 0;
  let previousWasWord = false;
  for (const match of value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g)) {
    const gap = value.slice(last, match.index);
    if (!(previousWasWord && /^[ \t]*$/.test(gap))) {
      out += gap;
    }
    out += b64ToText(match[1]);
    last = match.index + match[0].length;
    previousWasWord = true;
  }
  return out + value.slice(last);
}

describe('normalizeEmail', () => {
  it('parses string addresses with display names', async () => {
    const email = await normalizeEmail({
      from: 'Acme <hello@acme.dev>',
      to: 'user@example.com',
      subject: 'Welcome',
      text: 'Hi',
    });
    expect(email.from).toEqual({ email: 'hello@acme.dev', name: 'Acme' });
    expect(email.to).toEqual([{ email: 'user@example.com' }]);
  });

  it('parses object addresses', async () => {
    const email = await normalizeEmail({
      from: { email: 'a@x.dev', name: 'A' },
      to: { email: 'b@y.dev' },
      subject: 's',
      text: 't',
    });
    expect(email.from).toEqual({ email: 'a@x.dev', name: 'A' });
  });

  it('accepts arrays for to/cc/bcc', async () => {
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: ['b@y.dev', { email: 'c@y.dev', name: 'C' }],
      cc: 'd@y.dev',
      bcc: ['e@y.dev'],
      subject: 's',
      text: 't',
    });
    expect(email.to).toHaveLength(2);
    expect(email.cc).toHaveLength(1);
    expect(email.bcc).toHaveLength(1);
  });

  it('rejects missing text and html', async () => {
    await expect(
      normalizeEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's' }),
    ).rejects.toBeInstanceOf(MimeError);
  });

  it('rejects empty to list', async () => {
    await expect(
      normalizeEmail({ from: 'a@x.dev', to: [], subject: 's', text: 't' }),
    ).rejects.toThrow(/'to'/);
  });

  // RFC 5322 §2.1.1 makes 998 a MUST and §3.2.2 folds only at whitespace,
  // so a long ASCII token with no spaces cannot be folded at all.
  const TOKEN = 'x'.repeat(1100);

  /** Longest physical line of the rendered message, in octets. */
  async function longestLine(opts: Record<string, unknown>): Promise<number> {
    const email = await normalizeEmail(opts as never);
    const raw = new TextDecoder().decode(buildMime(email).raw);
    return Math.max(...raw.split('\r\n').map((l) => new TextEncoder().encode(l).length));
  }

  it.each([
    ['subject', { from: 'a@x.dev', to: 'b@y.dev', subject: TOKEN, text: 't' }],
    [
      'a custom header value',
      { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't', headers: { 'X-Trace': TOKEN } },
    ],
    [
      'a display name',
      { from: { email: 'a@x.dev', name: TOKEN }, to: 'b@y.dev', subject: 's', text: 't' },
    ],
    [
      'an attachment filename',
      {
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: `${TOKEN}.pdf`, content: new Uint8Array([1, 2, 3]) }],
      },
    ],
  ])('rejects an unbreakable token in %s rather than emitting a >998 octet line', async (_w, o) => {
    await expect(normalizeEmail(o as never).then((e) => buildMime(e))).rejects.toThrow(
      /998|line length/i,
    );
  });

  it('still accepts a token that lands exactly on the limit', async () => {
    // `Subject: ` costs 9 octets, so 989 is the largest token that fits.
    expect(
      await longestLine({ from: 'a@x.dev', to: 'b@y.dev', subject: 'x'.repeat(989), text: 't' }),
    ).toBe(998);
  });

  it('measures a line in UTF-8 octets, not UTF-16 units, and reports its number', async () => {
    // A CJK filename costs 3 octets per character inside 12 of framing, so
    // 328 characters land exactly on 998 octets and 329 are one over, though
    // both pass a `length` check.
    const fits = '漢'.repeat(328);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: [{ filename: fits, content: 'x' }],
    });
    expect(text).toContain(`\r\n filename="${fits}"\r\n`);
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: `${fits}漢`, content: 'x' }],
      }),
    ).rejects.toThrow(/header line 19 is 999 octets, over the 998-octet limit/);
  });

  // A quoted-string parameter carries `\\` and `"` only as quoted-pairs
  // (RFC 5322 §3.2.4 — qtext excludes both).
  it.each([
    ['a trailing backslash', 'bad\\'],
    ['an embedded backslash', 'a\\b'],
    ['a Windows path', 'C:\\Users\\bob\\report.pdf'],
    ['an embedded quote', 'he said "hi".pdf'],
    ['a plain name', 'normal.pdf'],
  ])('round-trips %s in the attachment filename', async (_what, filename) => {
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: [{ filename, content: new Uint8Array([1, 2, 3]) }],
    });
    const text = new TextDecoder().decode(buildMime(email).raw);

    // Recover it the way a receiver does: read the quoted-string back,
    // undoing quoted-pairs. A raw backslash before the closing quote would
    // leave the parameter unterminated and this would not match.
    const m = text.match(/Content-Disposition: attachment; filename="((?:[^"\\]|\\.)*)"/);
    expect(m, `no terminated filename parameter in:\n${text.slice(0, 400)}`).not.toBeNull();
    expect(m![1].replace(/\\(.)/g, '$1')).toBe(filename);
  });

  it('rejects CRLF in subject', async () => {
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 'X\r\nBcc: attacker@evil.dev',
        text: 't',
      }),
    ).rejects.toThrow(/subject/);
  });

  it('rejects CRLF in custom header values', async () => {
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { 'X-Campaign': 'welcome\r\nBcc: attacker@evil.dev' },
      }),
    ).rejects.toThrow(/X-Campaign/);
  });

  it('rejects invalid header names', async () => {
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { 'X-Bad\r\nInjected': 'v' },
      }),
    ).rejects.toThrow(/header name/);
  });

  it('rejects CRLF in address email', async () => {
    await expect(
      normalizeEmail({
        from: { email: 'a@x.dev\r\nBcc: attacker@evil.dev', name: 'A' },
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/from/);
  });

  it('rejects CRLF in display name', async () => {
    await expect(
      normalizeEmail({
        from: { email: 'a@x.dev', name: 'A\r\nBcc: attacker@evil.dev' },
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/from/);
  });

  it('rejects CRLF in attachment filename', async () => {
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: 'evil.txt\r\nX-Injected: 1', content: 'x' }],
      }),
    ).rejects.toThrow(/filename/);
  });

  it("rejects an attachment disposition other than 'attachment' or 'inline'", async () => {
    // The union is compile-time only: a JS caller can pass any string, which
    // would be written verbatim into `Content-Disposition`.
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' };
    const message = "attachment disposition must be 'attachment' or 'inline'.";
    for (const disposition of [
      'attachment\r\nX-Injected: 1',
      'attachment\r\n\r\nbody',
      'form-data',
    ]) {
      const attempt = normalizeEmail({
        ...base,
        attachments: [{ filename: 'f.txt', content: 'x', disposition: disposition as never }],
      });
      await expect(attempt).rejects.toThrow(message);
      await expect(attempt).rejects.toMatchObject({ code: 'MIME_ERROR' });
    }
    // Both literals still render as given, whatever the body shape.
    for (const disposition of ['attachment', 'inline'] as const) {
      const { text } = await build({
        ...base,
        attachments: [{ filename: 'f.txt', content: 'x', disposition }],
      });
      expect(text).toContain(`Content-Disposition: ${disposition}; filename="f.txt"`);
    }
    // And an omitted disposition still defaults on `contentId`.
    const defaulted = await normalizeEmail({
      ...base,
      attachments: [
        { filename: 'f.txt', content: 'x' },
        { filename: 'logo.png', content: 'x', contentId: 'logo' },
      ],
    });
    expect(defaulted.attachments.map((a) => a.disposition)).toEqual(['attachment', 'inline']);
  });

  // Base64 expands by `ceil(n / 3) * 4`, so attachments above three quarters
  // of the message cap can never fit.
  const MAX_ATTACHMENT_BYTES_TOTAL = Math.floor((MAX_MESSAGE_BYTES * 3) / 4);

  /** A one-byte Blob wearing a declared `size`, recording whether anything read it. */
  function fakeBlob(name: string, size: number, reads: Array<string>): Blob {
    const blob = new Blob([new Uint8Array(1)]);
    Object.defineProperty(blob, 'size', { value: size });
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => {
        reads.push(name);
        return new ArrayBuffer(size);
      },
    });
    return blob;
  }

  it('rejects an oversize attachment set without materializing past the first', async () => {
    const reads: Array<string> = [];
    const half = Math.ceil(MAX_ATTACHMENT_BYTES_TOTAL / 2) + 1;
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [
          { filename: 'first.bin', content: fakeBlob('first', half, reads) },
          { filename: 'second.bin', content: fakeBlob('second', half, reads) },
        ],
      }),
    ).rejects.toThrow(
      new RegExp(`exceeds Cloudflare limit of ${MAX_ATTACHMENT_BYTES_TOTAL} bytes`),
    );
    // The second attachment is charged from its declared size, before any byte is read.
    expect(reads).toEqual(['first']);
  });

  it('still builds a legal attachment under the bound', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: [{ filename: 'ok.bin', content: new Uint8Array(1024) }],
    });
    expect(text).toContain('Content-Disposition: attachment; filename="ok.bin"');
  });

  describe('attachment count', () => {
    // Zero-byte attachments never advance the byte budget, so the count is
    // refused before the loop, at the largest count the size projection admits.
    /** An attachment that records any read of the fields the loop touches first. */
    function watchedAttachment(reads: Array<number>, i: number): Attachment {
      return {
        get filename() {
          reads.push(i);
          return 'a';
        },
        get content() {
          reads.push(i);
          return '';
        },
      };
    }

    it('refuses one over MAX_ATTACHMENTS before normalizing any of them', async () => {
      const reads: Array<number> = [];
      const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) =>
        watchedAttachment(reads, i),
      );
      let error: unknown;
      try {
        await normalizeEmail({
          from: 'a@x.dev',
          to: 'b@y.dev',
          subject: 's',
          text: 't',
          attachments,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      expect((error as MimeError).code).toBe('MIME_ERROR');
      expect((error as MimeError).message).toBe(
        `email: too many attachments (max ${MAX_ATTACHMENTS}, got ${MAX_ATTACHMENTS + 1}).`,
      );
      expect(reads).toEqual([]);
    });

    it('accepts exactly MAX_ATTACHMENTS', async () => {
      const one = { filename: 'a', content: '' };
      const email = await normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: Array.from({ length: MAX_ATTACHMENTS }, () => one),
      });
      expect(email.attachments.length).toBe(MAX_ATTACHMENTS);
    });

    it('never rejects a count the size projection would have admitted', () => {
      // The smallest part there is. One over the cap is refused by the
      // projection on framing alone; at the cap the post-render check refuses it.
      const part = {
        filename: 'a',
        contentType: '',
        bytes: new Uint8Array(0),
        contentId: undefined,
        disposition: 'inline' as const,
      };
      const email = (n: number) => ({
        from: { email: 'a@x.dev' },
        to: [{ email: 'b@y.dev' }],
        cc: [],
        bcc: [],
        subject: 's',
        text: 't',
        headers: {},
        attachments: Array.from({ length: n }, () => part),
      });
      expect(() => buildMime(email(MAX_ATTACHMENTS + 1))).toThrow(
        /message is at least \d+ bytes once encoded, which exceeds Cloudflare limit/,
      );
      expect(() => buildMime(email(MAX_ATTACHMENTS))).toThrow(
        /message size \d+ bytes exceeds Cloudflare limit/,
      );
    });

    it('refuses a non-array attachments value instead of walking it unbounded', async () => {
      // A `Set` iterates but has no `length`, so a count read off the
      // options would bound nothing; the type admits only an array.
      await expect(
        normalizeEmail({
          from: 'a@x.dev',
          to: 'b@y.dev',
          subject: 's',
          text: 't',
          attachments: new Set([{ filename: 'a', content: '' }]) as unknown as Array<Attachment>,
        }),
      ).rejects.toThrow(/attachments must be an array/);
    });
  });

  /**
   * An object address whose `email` records every read. `parseAddress` has
   * to read it to do anything at all, so an untouched entry proves the list
   * was refused before it was parsed.
   */
  function watchedAddress(reads: Array<number>, i: number): { email: string } {
    return {
      get email() {
        reads.push(i);
        return `u${i}@example.com`;
      },
    };
  }

  it('refuses more than MAX_RECIPIENTS across to, cc and bcc before parsing any of them', async () => {
    const reads: Array<number> = [];
    const to = Array.from({ length: MAX_RECIPIENTS - 1 }, (_, i) => watchedAddress(reads, i));
    let error: unknown;
    try {
      await normalizeEmail({
        from: 'a@x.dev',
        to,
        cc: watchedAddress(reads, MAX_RECIPIENTS - 1),
        bcc: [watchedAddress(reads, MAX_RECIPIENTS)],
        subject: 's',
        text: 't',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MimeError);
    expect((error as MimeError).code).toBe('INVALID_TO');
    expect((error as MimeError).message).toMatch(
      new RegExp(`too many recipients \\(max ${MAX_RECIPIENTS}, got ${MAX_RECIPIENTS + 1}\\)`),
    );
    expect(reads).toEqual([]);
  });

  it('accepts exactly MAX_RECIPIENTS across the three fields', async () => {
    const to = Array.from({ length: MAX_RECIPIENTS - 2 }, (_, i) => `u${i}@example.com`);
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to,
      cc: 'cc@example.com',
      bcc: ['bcc@example.com'],
      subject: 's',
      text: 't',
    });
    expect(email.to.length + email.cc.length + email.bcc.length).toBe(MAX_RECIPIENTS);
  });

  it('refuses a quoted filename that could never fold onto a legal line, before rendering it', async () => {
    // ` filename="…"` is the shortest line a quoted parameter can land on:
    // 12 octets plus the name.
    const longest = 'a'.repeat(998 - 12);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: [{ filename: longest, content: 'x' }],
    });
    expect(text).toContain(`filename="${longest}"`);
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: `${longest}b`, content: 'x' }],
      }),
    ).rejects.toThrow(
      /attachment filename is 987 characters; a quoted `filename=` parameter cannot be folded/,
    );
    // The guard refuses a huge input without escaping it.
    const started = performance.now();
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: '"'.repeat(2_000_000), content: 'x' }],
      }),
    ).rejects.toThrow(/cannot be folded/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses a quoted display name that could never fold onto a legal line', async () => {
    // Only a name that must be QUOTED (ASCII with specials) is one
    // unbreakable token; a plain name folds at its spaces and a non-ASCII
    // name becomes encoded-words, so neither is bounded here.
    const plain = 'word '.repeat(300).trim();
    await expect(
      build({ from: 'a@x.dev', to: { email: 'b@y.dev', name: plain }, subject: 's', text: 't' }),
    ).resolves.toBeTruthy();
    const quotedFits = `x,${'a'.repeat(998 - 3 - 2)}`;
    await expect(
      build({
        from: 'a@x.dev',
        to: { email: 'b@y.dev', name: quotedFits },
        subject: 's',
        text: 't',
      }),
    ).resolves.toBeTruthy();
    await expect(
      build({
        from: 'a@x.dev',
        to: { email: 'b@y.dev', name: `${quotedFits}b` },
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(
      /to: display name is 996 characters and must be quoted, which cannot be folded/,
    );
    await expect(
      build({
        from: 'a@x.dev',
        to: { email: 'b@y.dev', name: '"'.repeat(2_000_000) },
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/cannot be folded/);
  });

  it('refuses a header name that could never sit on a legal line, before rendering it', async () => {
    // A field name never folds, and `Name:` alone is the shortest line it can
    // sit on, so 997 characters is the longest name with any legal rendering
    // (with a value that folds). Over an empty value the line check refuses it.
    const longest = `X${'a'.repeat(998 - 1 - 1)}`;
    expect(longest).toHaveLength(997);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      headers: { [longest]: 'a b' },
    });
    expect(headerLines(text, longest)).toEqual([`${longest}:`, ' a b']);
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { [longest]: '' },
      }),
    ).rejects.toThrow(/header line \d+ is 999 octets, over the 998-octet limit/);
    // One character more has no legal rendering whatever the value.
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { [`${longest}b`]: 'a b' },
      }),
    ).rejects.toThrow(/headers: a header name is 998 characters; a field name cannot be folded/);
    // The guard refuses a huge name without rendering it.
    const started = performance.now();
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { ['X'.repeat(5 * 1024 * 1024)]: '' },
      }),
    ).rejects.toThrow(/a field name cannot be folded/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses an address over MAX_ADDRESS_LENGTH, with the code for its field', async () => {
    // RFC 5321 §4.5.3.1: 64 + `@` + 255 is the pre-parse bound; the package's
    // 254 is the deliverable one. At exactly 320 the package answers.
    const longest = `${'a'.repeat(64)}@${'b'.repeat(251)}.dev`;
    expect(longest).toHaveLength(MAX_ADDRESS_LENGTH);
    const over = `${'a'.repeat(65)}@${'b'.repeat(251)}.dev`;
    await expect(
      normalizeEmail({ from: 'a@x.dev', to: longest, subject: 's', text: 't' }),
    ).rejects.toThrow(invalidAddress('to'));
    // 254 characters of 63-character-or-shorter labels: the longest address
    // the package accepts.
    const deliverable = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.dev`;
    expect(deliverable).toHaveLength(254);
    const email = await normalizeEmail({
      from: deliverable,
      to: deliverable,
      subject: 's',
      text: 't',
    });
    expect(email.to[0].email).toBe(deliverable);
    for (const [field, code] of [
      ['to', 'INVALID_TO'],
      ['from', 'INVALID_FROM'],
      ['cc', 'MIME_ERROR'],
    ] as const) {
      let error: unknown;
      try {
        await normalizeEmail({
          from: 'a@x.dev',
          to: 'b@y.dev',
          [field]: over,
          subject: 's',
          text: 't',
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      expect((error as MimeError).code).toBe(code);
      expect((error as MimeError).message).toMatch(
        new RegExp(
          `^${field}: address is ${over.length} characters, over the ${MAX_ADDRESS_LENGTH}-character limit`,
        ),
      );
    }
    // The bound is on the parsed address, as at the proxy — a long display
    // name around a legal address is not an oversize address.
    const named = await normalizeEmail({
      from: 'a@x.dev',
      to: `"${'n'.repeat(2 * MAX_ADDRESS_LENGTH)}" <${deliverable}>`,
      subject: 's',
      text: 't',
    });
    expect(named.to[0].email).toBe(deliverable);
    // The bound answers before the address is scanned.
    expect(() => parseAddress(`a\x01${'b'.repeat(320)}@x.dev`, 'to')).toThrow(
      /over the 320-character limit/,
    );
  });

  describe('address rule', () => {
    // `validateAddressParts` is `email-validator`, the package the platform
    // router applies too; its message names the rule and never echoes the address.
    const label = 'b'.repeat(63);
    const domain255 = [label, label, label, label].join('.');

    async function addressError(
      field: 'to' | 'from' | 'cc' | 'bcc' | 'replyTo',
      address: string | { name?: string; email: string },
    ): Promise<MimeError> {
      let error: unknown;
      try {
        await normalizeEmail({
          from: 'a@x.dev',
          to: 'b@y.dev',
          [field]: address,
          subject: 's',
          text: 't',
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      return error as MimeError;
    }

    it.each([
      ['no @', 'no-at-sign'],
      ['an empty domain', 'user@'],
      ['an empty local part', '@example.com'],
      ['two @', 'a@b@c'],
      ['whitespace', 'a b@x.dev'],
      ['a comma', 'victim@example.com,attacker@evil.dev'],
      ['a semicolon', 'a@x.dev;b@evil.dev'],
      ['a dot-less domain', 'user@localhost'],
      ['a one-letter domain', 'x@y'],
      ['a domain with no TLD', 'a@example'],
      ['a one-letter TLD', 'a@b.c'],
      ['a TLD starting with a digit', 'a@b.1c'],
      ['a TLD ending with a hyphen', 'a@b.c-'],
      ['a TLD starting with a hyphen', 'a@b.-c'],
      // RFC 5321 §4.5.3.1.3: a 256-octet path, so at most 254 for the address.
      ['257 characters, under the 320 bound', `a@${domain255}`],
      // RFC 5321 §4.5.3.1.1: at most 64 octets before the @.
      ['a 65-character local part', `${'a'.repeat(65)}@x.dev`],
      [
        'a 65-character local part and 266 in total',
        `${'a'.repeat(65)}@${domain255.slice(0, 200)}`,
      ],
      ['a 64-character domain label', `a@${'b'.repeat(64)}.dev`],
      ['a raw IDN domain', 'a@exämple.com'],
      ['a long raw IDN domain', `a@${'ü'.repeat(31)}.${'b'.repeat(63)}`],
      ['a non-ASCII local part', 'ünicode@example.com'],
      ['an accented local part', 'jöhn@example.com'],
      ['a CJK local part', `${'漢'.repeat(21)}@x.dev`],
      ['a quoted local part', '"a b"@example.com'],
      ['a quoted @', '"a@b"@example.com'],
      ['a quoted word', '"weird"@x.dev'],
      ['SOH', 'a\x01b@example.com'],
      ['ESC', 'a\x1bb@example.com'],
      ['US', 'a\x1fb@example.com'],
      ['DEL', 'a\x7fb@example.com'],
      ['TAB', 'a\tb@example.com'],
      // `:` is an RFC 5322 §3.2.3 special, not atext.
      ['a colon in the local part', 'a:b@example.com'],
      ['a colon in the domain', 'a@b:c.example.com'],
      ['a leading colon', ':a@example.com'],
      ['a trailing colon', 'a@example.com:'],
      ['doubled dots in the local part', 'a..b@example.com'],
      ['a leading dot', '.a@example.com'],
      ['a dot before the @', 'a.@example.com'],
      ['doubled dots in the domain', 'a@example..com'],
      ['a dot after the @', 'a@.example.com'],
      ['a trailing dot', 'a@example.com.'],
    ])(
      'refuses an address with %s, bare, as an object and in a display name',
      async (_label, bad) => {
        expect((await addressError('to', bad)).message).toBe(invalidAddress('to'));
        expect((await addressError('to', { name: 'Bob', email: bad })).message).toBe(
          invalidAddress('to'),
        );
        expect(() => parseAddress(`Bob <${bad}>`, 'to')).toThrow(invalidAddress('to'));
      },
    );

    it.each([
      ['to', 'INVALID_TO'],
      ['from', 'INVALID_FROM'],
      ['cc', 'MIME_ERROR'],
      ['bcc', 'MIME_ERROR'],
      ['replyTo', 'MIME_ERROR'],
    ] as const)('refuses an invalid %s address with %s', async (field, code) => {
      const error = await addressError(field, 'a..b@example.com');
      expect(error.code).toBe(code);
      expect(error.message).toBe(invalidAddress(field));
    });

    it('refuses CR, LF and NUL in an object address by the rule, and in a string before parsing', async () => {
      for (const ch of ['\r', '\n', '\0']) {
        const error = await addressError('to', { email: `a${ch}b@example.com` });
        expect(error.code).toBe('INVALID_TO');
        expect(error.message).toBe(invalidAddress('to'));
        expect(() => parseAddress(`Bob <a${ch}b@example.com>`, 'to')).toThrow(
          /must not contain CR, LF, or NUL/,
        );
      }
    });

    it.each([
      ['a 254-character address', `a@${domain255.slice(0, 252)}`],
      ['a 64-character local part', `${'a'.repeat(64)}@x.dev`],
      ['a punycode IDN domain', 'a@xn--bcher-kva.example'],
      ['dots between atoms', 'first.last@example.com'],
      ['dots on both sides', 'a.b.c@sub.example.co.uk'],
      ['a dotted domain', 'a@sub.sub.example.com'],
      ['a TLD ending in a digit', 'a@b.c1'],
      ['a two-letter TLD', 'a@b.co'],
      ['a hyphen inside the TLD', 'a@b.c-d'],
      ['a hyphenated label', 'a@b-c.example'],
      ['every atext symbol after the first character', "a!#$%&'*+-/=?^_`{|}~@example.com"],
    ])('accepts %s', async (_label, ok) => {
      const email = await normalizeEmail({ from: ok, to: ok, subject: 's', text: 't' });
      expect(email.from.email).toBe(ok);
      expect(email.to[0].email).toBe(ok);
    });

    it('never renders a control character raw from a display name, which is encoded instead', async () => {
      // A name is not an address: `formatAddress` RFC 2047-encodes a
      // non-printable name, so the byte reaches the wire only inside base64.
      // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the point
      const rawControl = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/;
      for (const ch of ['\x01', '\x1b', '\x1f', '\x7f', '\t']) {
        const { text } = await build({
          from: 'a@x.dev',
          to: { name: `Bo${ch}b`, email: 'b@y.dev' },
          subject: 's',
          text: 't',
        });
        const toLine = unfoldHeader(text, 'To');
        expect(toLine).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <b@y\.dev>$/);
        expect(decodeEncodedWords(toLine)).toBe(`Bo${ch}b <b@y.dev>`);
        expect(text.slice(0, text.indexOf('\r\n\r\n'))).not.toMatch(rawControl);
      }
    });
  });

  describe('control characters in an attachment filename', () => {
    // A filename is rendered raw inside a quoted-string, where a control is
    // `obs-qtext` (RFC 5322 §3.2.4), which §4 says MUST NOT be generated.
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' };
    const controls = [
      ['SOH', '\x01', 'U+0001'],
      ['ESC', '\x1b', 'U+001B'],
      ['US', '\x1f', 'U+001F'],
      ['DEL', '\x7f', 'U+007F'],
    ] as const;

    it('refuses one, naming its code point rather than echoing it', async () => {
      for (const [, ch, point] of controls) {
        let error: unknown;
        try {
          await normalizeEmail({
            ...base,
            attachments: [{ filename: `invoice${ch}.pdf`, content: 'x' }],
          });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(MimeError);
        expect((error as MimeError).code).toBe('MIME_ERROR');
        expect((error as MimeError).message).toBe(
          `attachment filename contains a control character (${point}).`,
        );
        expect((error as MimeError).message).not.toContain(ch);
      }
      // CR, LF and NUL answer first, by `rejectCRLF`.
      for (const ch of ['\r', '\n', '\0']) {
        await expect(
          normalizeEmail({ ...base, attachments: [{ filename: `a${ch}b.pdf`, content: 'x' }] }),
        ).rejects.toThrow('attachment filename: must not contain CR, LF, or NUL.');
      }
    });

    it('accepts HTAB, which is folding white space inside a quoted-string (RFC 5322 §3.2.4), unchanged', async () => {
      // `FWS` is SP / HTAB, so a tab inside a quoted-string is legal like a space.
      const { text } = await build({
        ...base,
        attachments: [{ filename: 'a\tb.pdf', content: 'x' }],
      });
      expect(text).toContain('; name="a\tb.pdf"\r\n');
      expect(text).toContain('; filename="a\tb.pdf"\r\n');
    });

    it('still renders a non-ASCII filename as raw UTF-8 in the quoted parameter', async () => {
      // No RFC 2231 `filename*=` and no encoded-word: the UTF-8 octets go
      // inside the quotes.
      const { raw, text } = await build({
        ...base,
        attachments: [{ filename: 'résumé.pdf', content: 'x' }],
      });
      expect(text).toContain('; name="résumé.pdf"\r\n');
      expect(text).toContain('; filename="résumé.pdf"\r\n');
      expect(text).not.toContain('filename*=');
      const hex = [...raw].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      expect(hex).toContain('66 69 6c 65 6e 61 6d 65 3d 22 72 c3 a9 73 75 6d c3 a9 2e 70 64 66 22');
    });

    it('keeps the length bound in front of the scan', async () => {
      // "Bound before you scan": an over-long filename is refused by the
      // `QUOTED_FILENAME_LINE_OVERHEAD` guard before its characters are read.
      const filename = `a\x01${'b'.repeat(2000)}.pdf`;
      await expect(
        normalizeEmail({ ...base, attachments: [{ filename, content: 'x' }] }),
      ).rejects.toThrow(
        new RegExp(
          `attachment filename is ${filename.length} characters; a quoted \`filename=\` parameter cannot be folded`,
        ),
      );
    });

    it('refuses one in the media type by the same rule', async () => {
      // `Content-Type: <contentType>; name="…"` is rendered verbatim, and an
      // RFC 2045 §5.1 `token` excludes CTLs.
      await expect(
        normalizeEmail({
          ...base,
          attachments: [{ filename: 'a.pdf', content: 'x', contentType: 'application/pdf\x01' }],
        }),
      ).rejects.toThrow('attachment contentType contains a control character (U+0001).');
    });

    it('refuses one in the Content-ID by the same rule', async () => {
      // `Content-ID: <cid>` is rendered verbatim, and an RFC 5322 §3.6.4
      // `msg-id` is `dot-atom-text` — no control at all.
      await expect(
        normalizeEmail({
          ...base,
          attachments: [{ filename: 'a.png', content: 'x', contentId: 'lo\x7fgo' }],
        }),
      ).rejects.toThrow('attachment contentId contains a control character (U+007F).');
    });
  });

  describe('media type syntax of an attachment', () => {
    // The media type is written verbatim ahead of the builder's `; name="…"`,
    // so it must match RFC 2045 §5.1 `type "/" subtype *(";" parameter)`.
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' };
    const SYNTAX =
      'attachment contentType is not a valid media type (RFC 2045 §5.1: type/subtype, then ; attribute=value parameters).';

    async function refused(contentType: string): Promise<MimeError> {
      let error: unknown;
      try {
        await normalizeEmail({
          ...base,
          attachments: [{ filename: 'a.txt', content: 'x', contentType }],
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      expect((error as MimeError).code).toBe('MIME_ERROR');
      return error as MimeError;
    }

    it('refuses one that does not parse, naming the rule rather than echoing it', async () => {
      const invalid = [
        'text/plain; x="', // unterminated quoted-string
        'text/plain; x="a\\"', // the `\` escapes the closing quote
        'text/plain; charset', // attribute without `=` value
        'text/plain; charset=', // empty token value (`""` is the empty value)
        'text/plain; x=a/b', // `/` is a tspecial; must be quoted
        'text', // subtype is MANDATORY (§5.1)
        'text/', //
        '/plain', //
        'text/plain/x', //
        'text/ plain', // WSP inside the type
        'text plain', //
        ' text/plain', // leading WSP
        'text/plain ', // trailing WSP
        'text/plain;', // `;` owes a parameter
        'text/plain;;', //
        'text/plain; ; a=b', //
        'text/plain; a=b,c', // `,` is a tspecial
        'text/plain (plain text)', // an RFC 822 comment: refused, not stripped
        'tëxt/plain', // token is US-ASCII
        'text/plain; ä=b', //
        'text/plain; a=ö', //
        '', //
      ];
      for (const contentType of invalid) {
        const error = await refused(contentType);
        expect(error.message, contentType).toBe(SYNTAX);
        if (contentType.length > 0) {
          expect(error.message).not.toContain(contentType);
        }
      }
    });

    it('accepts every valid form and renders it verbatim', async () => {
      const valid = [
        'TEXT/PLAIN', // case is kept as given; matching is case-insensitive
        'application/vnd.ms-excel',
        'application/x-foo.bar-baz_1', // `.`, `-`, `_` are token characters
        'image/svg+xml',
        'text/plain; charset=utf-8',
        'text/plain; charset="utf-8"',
        'text/plain;charset=utf-8', // no WSP after `;`
        'text/plain ; charset=utf-8', // WSP before `;` (RFC 822 implicit LWSP)
        'text/plain;\tcharset=utf-8', // HTAB is WSP
        'text/plain; charset=""', // the empty quoted-string is a value
        'text/plain; title="a \\"b\\" \\\\ c; d=e"', // quoted-pairs, and `;` inside quotes
        'text/plain; title="résumé"', // what `name="résumé.pdf"` already carries
        'multipart/x-thing; a=1; B=2', // distinct attributes
      ];
      for (const contentType of valid) {
        const { text } = await build({
          ...base,
          attachments: [{ filename: 'a.txt', content: 'x', contentType }],
        });
        // Verbatim, then the builder's own parameter.
        expect(text, contentType).toContain(`Content-Type: ${contentType}; name="a.txt"\r\n`);
      }
    });

    /**
     * The attachment part's `Content-Type` header, every physical line of
     * it: the lines between `Content-Type:` and the part's
     * `Content-Transfer-Encoding: base64`, which only an attachment carries.
     */
    async function attachmentContentTypeLines(contentType: string): Promise<Array<string>> {
      const { text } = await build({
        ...base,
        attachments: [{ filename: 'a.txt', content: 'x', contentType }],
      });
      const lines = text.split('\r\n');
      const end = lines.indexOf('Content-Transfer-Encoding: base64');
      let start = end - 1;
      while (start > 0 && !lines[start].startsWith('Content-Type:')) {
        start--;
      }
      return lines.slice(start, end);
    }

    it('keeps the length bound in front of the scan', async () => {
      // "Bound before you scan": the `CONTENT_TYPE_LINE_OVERHEAD` guard
      // answers for an over-long value before the grammar reads it — the
      // stray `"` in here is never reached. ` <type>;` is the shortest line
      // the media type can fold onto, so 996 characters render exactly at
      // the 998-octet limit and 997 cannot.
      const error = await refused(`a/b"${'c'.repeat(2000)}`);
      expect(error.message).toBe(
        'attachment contentType is 2004 characters; at most 996 fit on the Content-Type line ' +
          'under the 998-octet limit in RFC 5322 §2.1.1. Shorten it.',
      );
      expect((await refused(`a/${'b'.repeat(995)}`)).message).toMatch(
        /^attachment contentType is 997 characters; at most 996 fit/,
      );
      const lines = await attachmentContentTypeLines(`a/${'b'.repeat(994)}`);
      expect(lines).toEqual(['Content-Type:', ` a/${'b'.repeat(994)};`, ' name="a.txt"']);
      expect(lines[1].length).toBe(998);
    });

    it("refuses a caller's name= parameter, which the builder sets from the filename", async () => {
      // `buildAttachmentPart` appends `name="<filename>"`, so a second one
      // would be the same parameter twice — RFC 6838 §4.3: "It is an error
      // for a specific parameter to be specified more than once."
      for (const contentType of ['text/plain; name=other', 'text/plain; NAME="other"']) {
        expect((await refused(contentType)).message).toBe(
          'attachment contentType must not carry a name= parameter; the builder adds name="<filename>" itself.',
        );
      }
    });

    it('refuses a parameter given twice, whatever its case (RFC 6838 §4.3)', async () => {
      // §5.1: "Matching of attributes is ALWAYS case-insensitive", and
      // §4.3 of RFC 6838 makes a repeat an error; a parser that keeps the
      // first and one that keeps the last would disagree on the message.
      for (const contentType of [
        'text/plain; a=b; a=c',
        'text/plain; charset=utf-8; CHARSET=ascii',
      ]) {
        expect((await refused(contentType)).message).toBe(
          'attachment contentType gives the same parameter twice; attribute names are case-insensitive and each may appear once (RFC 6838 §4.3).',
        );
      }
    });

    it('reports a syntax error ahead of a semantic one on the same parameter', async () => {
      // `name` without a value is a syntax error first.
      expect((await refused('text/plain; name')).message).toBe(SYNTAX);
    });
  });

  describe('Content-ID syntax of an attachment', () => {
    // The Content-ID is written verbatim, bracketed unless it starts with `<`,
    // so it must be an RFC 5322 §3.6.4 `msg-id`; the `@` side and the
    // brackets are optional (RFC 2392 §2 resolves `cid:x` against `<x>`).
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', html: '<img src="cid:logo">' };
    const SYNTAX =
      'attachment contentId is not a valid Content-ID (RFC 5322 §3.6.4 msg-id: an identifier of atext, "." and "@", optionally in one pair of angle brackets).';

    async function refused(contentId: string): Promise<MimeError> {
      let error: unknown;
      try {
        await normalizeEmail({
          ...base,
          attachments: [{ filename: 'logo.png', content: 'x', contentId }],
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      expect((error as MimeError).code).toBe('MIME_ERROR');
      return error as MimeError;
    }

    /** The attachment part's rendered `Content-ID` line. */
    async function contentIdLine(contentId: string): Promise<string | undefined> {
      const { text } = await build({
        ...base,
        attachments: [{ filename: 'logo.png', content: 'x', contentId }],
      });
      return text.split('\r\n').find((line) => line.startsWith('Content-ID:'));
    }

    it('refuses one that does not parse, naming the rule rather than echoing it', async () => {
      const invalid = [
        'logo other', // WSP: rendered `<logo other>`
        '<logo', // unterminated: rendered `<logo`
        'logo>', // rendered `<logo>>`
        '<logo>>', //
        '<<logo>', //
        '<logo>x', // text after the closing bracket
        '<>', // brackets around nothing
        '<', //
        '>', //
        ' logo', // leading WSP
        'logo ', // trailing WSP
        'lo\tgo', // HTAB is WSP too (`rejectControls` lets it through)
        'lo"go', // `"` is not atext
        'lo(go)', // nor `(` `)`: an RFC 822 comment is refused, not stripped
        'lo,go', //
        'lo;go', //
        'lo:go', //
        'lo\\go', //
        'a@[127.0.0.1]', // `no-fold-literal` is left out
        'a..b', // `dot-atom-text` is 1*atext *("." 1*atext): no doubled dot
        '.a', // no leading dot
        'a.', // no trailing dot
        'a.@b', // nor on either side of the `@`
        'a@.b', //
        'a@b@c', // one `@` at most
        '@b', // an `@` owes both sides
        'a@', //
        'lögo', // atext is US-ASCII
        '', //
      ];
      for (const contentId of invalid) {
        const error = await refused(contentId);
        expect(error.message, JSON.stringify(contentId)).toBe(SYNTAX);
        if (contentId.length > 0) {
          expect(error.message).not.toContain(contentId);
        }
      }
    });

    it('accepts every valid form and renders it verbatim', async () => {
      // Bare or bracketed, the wire form is `<id>`; a bracketed id renders
      // as given, a bare one is wrapped.
      const valid: Array<[contentId: string, rendered: string]> = [
        ['logo', '<logo>'], // the documented example: no `@` (RFC 2392 §2)
        ['<logo>', '<logo>'],
        ['logo@example.com', '<logo@example.com>'], // a proper RFC 5322 msg-id
        ['<logo@example.com>', '<logo@example.com>'],
        ['a.b', '<a.b>'],
        ['a.b.c@d.e', '<a.b.c@d.e>'],
        ["!#$%&'*+-/=?^_`{|}~", "<!#$%&'*+-/=?^_`{|}~>"], // every atext symbol
        ['20240101.1234@mail.void.cloud', '<20240101.1234@mail.void.cloud>'],
        ['Logo-1_2', '<Logo-1_2>'], // case is kept as given
      ];
      for (const [contentId, rendered] of valid) {
        expect(await contentIdLine(contentId), contentId).toBe(`Content-ID: ${rendered}`);
      }
    });

    it('still infers disposition from a bracketed id', async () => {
      // `att.contentId ? 'inline' : 'attachment'`: any id the grammar
      // admits is non-empty, so the default is `inline` for both forms.
      const email = await normalizeEmail({
        ...base,
        attachments: [
          { filename: 'a.png', content: 'x', contentId: 'a' },
          { filename: 'b.png', content: 'x', contentId: '<b>' },
        ],
      });
      expect(email.attachments.map((a) => a.disposition)).toEqual(['inline', 'inline']);
    });

    it('keeps the length bound in front of the scan', async () => {
      // "Bound before you scan": the `CONTENT_ID_LINE_OVERHEAD` guard
      // answers for an over-long value before the grammar reads it — the
      // space in here is never reached. `Content-ID: <id>` is one token,
      // so it never folds: a bare id of 984 characters renders exactly at
      // the 998-octet limit and 985 cannot; an id that brings its own
      // brackets is allowed those two characters more.
      const error = await refused(`x ${'x'.repeat(1998)}`);
      expect(error.message).toBe(
        'attachment contentId is 2000 characters; at most 984 fit on the Content-ID line ' +
          'under the 998-octet limit in RFC 5322 §2.1.1. Shorten it.',
      );
      expect((await refused('x'.repeat(985))).message).toMatch(
        /^attachment contentId is 985 characters; at most 984 fit/,
      );
      const bare = await contentIdLine('x'.repeat(984));
      expect(bare).toBe(`Content-ID: <${'x'.repeat(984)}>`);
      expect(bare!.length).toBe(998);
      expect((await refused(`<${'x'.repeat(985)}>`)).message).toMatch(
        /^attachment contentId is 987 characters; at most 986 fit/,
      );
      const bracketed = await contentIdLine(`<${'x'.repeat(984)}>`);
      expect(bracketed).toBe(`Content-ID: <${'x'.repeat(984)}>`);
      expect(bracketed!.length).toBe(998);
    });
  });

  it('accepts a colon in a display name, where it is quoted', async () => {
    // A name is a phrase, and a phrase with a special is rendered as one
    // quoted-string — the address rule is not the name rule.
    const { text } = await build({
      from: 'a@x.dev',
      to: { name: 'Ops: Tier 2', email: 'b@y.dev' },
      subject: 's',
      text: 't',
    });
    expect(unfoldHeader(text, 'To')).toBe('"Ops: Tier 2" <b@y.dev>');
  });

  it('parses the display-name form in linear time', () => {
    // Quantifiers that share a whitespace run backtrack cubically, and a regex
    // cannot be interrupted: keep the run where a regression costs seconds.
    const run = ' '.repeat(4000);
    const started = performance.now();
    expect(parseAddress(`${run}a@b.cd`, 'to')).toEqual({ email: 'a@b.cd' });
    expect(() => parseAddress(`${run}<a@b.cd`, 'to')).toThrow(MimeError);
    expect(parseAddress(`\t${run}Name${run}<a@b.cd>${run}`, 'to')).toEqual({
      email: 'a@b.cd',
      name: 'Name',
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('pins the language of the display-name form', () => {
    expect(parseAddress('a>b <c@d.ef>', 'to')).toEqual({ email: 'c@d.ef', name: 'a>b' });
    expect(parseAddress('x<a@b.cd>', 'to')).toEqual({ email: 'a@b.cd', name: 'x' });
    expect(parseAddress('\tJohn\tSmith\t<j@s.ef>', 'to')).toEqual({
      email: 'j@s.ef',
      name: 'John\tSmith',
    });
    expect(parseAddress('   <a@b.cd>   ', 'to')).toEqual({ email: 'a@b.cd' });
    expect(() => parseAddress('a"b <c@d.ef>', 'to')).toThrow(MimeError);
    expect(() => parseAddress('a <b@c.d> e', 'to')).toThrow(MimeError);
    expect(() => parseAddress('<a b@c.d>', 'to')).toThrow(MimeError);
  });

  it('undoes quoted-pairs in a quoted display name, and only there', () => {
    // RFC 5322 §3.2.4: inside a quoted-string `"` and `\` appear only as
    // `\"` and `\\`, and `\x` is `x` for any other `x`. The parsed name is
    // what `formatAddress` quotes and escapes again, so it has to be the
    // raw text — what the object form carries — or the escapes render
    // twice and the recipient sees the backslashes.
    expect(parseAddress('"Smith \\"Bob\\"" <a@x.dev>', 'to')).toEqual({
      email: 'a@x.dev',
      name: 'Smith "Bob"',
    });
    expect(parseAddress('"a\\\\b" <a@x.dev>', 'to')).toEqual({ email: 'a@x.dev', name: 'a\\b' });
    expect(parseAddress('"ab\\\\" <a@x.dev>', 'to')).toEqual({ email: 'a@x.dev', name: 'ab\\' });
    expect(parseAddress('"a\\xb" <a@x.dev>', 'to')).toEqual({ email: 'a@x.dev', name: 'axb' });
    // UTF-16 code units, surrogate pairs included.
    expect(parseAddress('"\\"😀 \\\\ ï" <a@x.dev>', 'to')).toEqual({
      email: 'a@x.dev',
      name: '"😀 \\ ï',
    });
    // A quoted name with no backslash is untouched, and a backslash in an
    // UNQUOTED name is a character like any other — as in the object form.
    expect(parseAddress('"Smith, John" <a@x.dev>', 'to')).toEqual({
      email: 'a@x.dev',
      name: 'Smith, John',
    });
    expect(parseAddress('a\\b <c@d.ef>', 'to')).toEqual({ email: 'c@d.ef', name: 'a\\b' });
    // `\@` is still an `@` in a display name, which is still refused.
    expect(() => parseAddress('"a\\@x" <b@y.dev>', 'to')).toThrow(/must not contain '@'/);
    // The quoted-string line guard sees the DECODED name, the one
    // `formatAddress` renders: 500 pairs are 1,000 raw characters (over
    // the guard) but a 500-character name (under it), and the count the
    // error reports is the decoded one.
    expect(parseAddress(`"${'\\"'.repeat(500)}" <a@x.dev>`, 'to').name).toBe('"'.repeat(500));
    expect(() => parseAddress(`"${'\\"'.repeat(996)}" <a@x.dev>`, 'to')).toThrow(
      /display name is 996 characters and must be quoted/,
    );
  });

  it('undoes quoted-pairs in linear time and without a per-pair allocation', () => {
    // Nothing bounds the name before the decode, and heap is not something a
    // test can pin; time is. Both shapes build the output of their path.
    const started = performance.now();
    expect(() => parseAddress(`"${'\\"'.repeat(1_000_000)}" <a@x.dev>`, 'to')).toThrow(
      /cannot be folded/,
    );
    const nonAscii = parseAddress(`"${'\\"é'.repeat(500_000)}" <a@x.dev>`, 'to');
    expect(nonAscii.name).toHaveLength(1_000_000);
    expect(nonAscii.name!.startsWith('"é"é')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('buildMime', () => {
  it('builds a plain text/plain message', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 'Hello',
      text: 'Hi there',
    });
    expect(text).toContain('From: a@x.dev');
    expect(text).toContain('To: b@y.dev');
    expect(text).toContain('Subject: Hello');
    expect(text).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(text).toContain('Hi there');
    expect(text).toMatch(/Message-ID: <[^@]+@x\.dev>/);
  });

  it('emits multipart/alternative when both text and html are set', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 'Hi',
      text: 'plain',
      html: '<p>html</p>',
    });
    expect(text).toContain('Content-Type: multipart/alternative;');
    expect(text).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(text).toContain('Content-Type: text/html; charset=UTF-8');
    expect(text).toContain('plain');
    expect(text).toContain('<p>html</p>');
  });

  it('encodes non-ASCII display names as RFC 2047 encoded-words', async () => {
    const { text } = await build({
      from: { email: 'j@x.dev', name: 'Jürgen Müller' },
      to: 'b@y.dev',
      subject: '日本語',
      text: 'hi',
    });
    expect(text).toMatch(/From: =\?UTF-8\?B\?[^?]+\?= <j@x\.dev>/);
    expect(text).toMatch(/Subject: =\?UTF-8\?B\?[^?]+\?=/);
  });

  // Only LF and CRLF end a line, a bare CR (or any other control character)
  // forces quoted-printable, and 990 printable characters is the longest 7bit line.
  it.each<[string, string, string, string]>([
    ['a bare CR', 'a\rb', 'quoted-printable', 'a\r\nb'],
    ['a tab', 'a\tb', 'quoted-printable', 'a\tb'],
    ['DEL', 'a\x7fb', 'quoted-printable', 'a=7Fb'],
    ['a 990-character line', 'a'.repeat(990), '7bit', 'a'.repeat(990)],
    [
      'a 991-character line',
      'a'.repeat(991),
      'quoted-printable',
      `${'a'.repeat(75)}=\r\n`.repeat(13) + 'a'.repeat(16),
    ],
    [
      'two 990-character lines split by a bare LF',
      `${'a'.repeat(990)}\n${'b'.repeat(990)}`,
      '7bit',
      `${'a'.repeat(990)}\r\n${'b'.repeat(990)}`,
    ],
    ['a mix of LF and CRLF', 'l1\nl2\r\nl3\n', '7bit', 'l1\r\nl2\r\nl3\r\n'],
  ])('encodes %s as %s', async (_what, input, encoding, expected) => {
    const { text } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: input });
    expect(text).toContain(`Content-Transfer-Encoding: ${encoding}`);
    expect(bodyOf(text)).toBe(expected);
  });

  it('attaches files as base64 in multipart/mixed', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      attachments: [
        {
          filename: 'hello.txt',
          content: 'hello world',
          contentType: 'text/plain',
        },
      ],
    });
    expect(text).toContain('Content-Type: multipart/mixed;');
    expect(text).toContain('Content-Disposition: attachment; filename="hello.txt"');
    expect(text).toContain('Content-Transfer-Encoding: base64');
    expect(text).toContain(btoa('hello world'));
  });

  it('renders cc, replyTo, and custom headers', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      cc: 'c@y.dev',
      bcc: 'd@y.dev',
      replyTo: 'r@x.dev',
      headers: { 'X-Campaign': 'welcome' },
      subject: 's',
      text: 'hi',
    });
    expect(text).toContain('Cc: c@y.dev');
    expect(text).toContain('Reply-To: r@x.dev');
    expect(text).toContain('X-Campaign: welcome');
    // Bcc must NOT appear in the rendered MIME — every recipient receives the
    // same raw body, so a Bcc header would expose the BCC list.
    expect(text).not.toContain('Bcc:');
    expect(text).not.toContain('d@y.dev');
  });

  it('drops user-supplied reserved headers', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      headers: { 'Content-Type': 'text/evil', From: 'spoof@x.dev' },
    });
    expect(text).not.toContain('text/evil');
    expect(text).not.toContain('spoof@x.dev');
  });

  it('uses multipart/related for inline attachments alongside html', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      html: '<img src="cid:logo">',
      attachments: [
        {
          filename: 'logo.png',
          content: new Uint8Array([1, 2, 3]),
          contentType: 'image/png',
          contentId: 'logo',
          disposition: 'inline',
        },
      ],
    });
    expect(text).toContain('Content-Type: multipart/related;');
    expect(text).toContain('Content-Disposition: inline; filename="logo.png"');
    expect(text).toContain('Content-ID: <logo>');
  });

  it('quotes display names containing RFC 5322 specials (comma is the worst)', async () => {
    // Comma in a name MUST be quoted — without quotes it splits the
    // address-list field.
    const { text } = await build({
      from: { email: 'a@x.dev', name: 'Smith, John' },
      to: { email: 'b@y.dev', name: 'Doe; Jane' },
      subject: 's',
      text: 'hi',
    });
    expect(text).toContain('From: "Smith, John" <a@x.dev>');
    expect(text).toContain('To: "Doe; Jane" <b@y.dev>');
  });

  it('quotes display names containing parens, angles, colons', async () => {
    const cases: Array<[string, string]> = [
      ['Acme (US)', '"Acme (US)"'],
      ['<spoof>', '"<spoof>"'],
      ['phone: x', '"phone: x"'],
    ];
    for (const [name, expected] of cases) {
      const { text } = await build({
        from: { email: 'a@x.dev', name },
        to: 'b@y.dev',
        subject: 's',
        text: 'hi',
      });
      expect(text).toContain(`From: ${expected} <a@x.dev>`);
    }
  });

  it('escapes embedded quotes and backslashes in quoted display names', async () => {
    const { text } = await build({
      from: { email: 'a@x.dev', name: 'Smith, "Bob" \\Bobby' },
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
    });
    // Backslash is escaped first (`\` → `\\`), then quotes are escaped
    // (`"` → `\"`). Order matters; reverse order would double-escape the
    // backslash from the quote-escape into `\\\\\"`.
    expect(text).toContain('From: "Smith, \\"Bob\\" \\\\Bobby" <a@x.dev>');
  });

  it('renders a quoted display name with its quoted-pairs escaped exactly once', async () => {
    // The string and object forms of the same name render the same header.
    const cases: Array<[string, string, string]> = [
      ['"Smith \\"Bob\\"" <a@x.dev>', 'Smith "Bob"', '"Smith \\"Bob\\""'],
      ['"a\\\\b" <a@x.dev>', 'a\\b', '"a\\\\b"'],
      ['"ab\\\\" <a@x.dev>', 'ab\\', '"ab\\\\"'],
      ['"Smith, John" <a@x.dev>', 'Smith, John', '"Smith, John"'],
      ['"a\\xb" <a@x.dev>', 'axb', 'axb'],
    ];
    for (const [from, name, rendered] of cases) {
      const viaString = await build({ from, to: 'b@y.dev', subject: 's', text: 't' });
      const viaObject = await build({
        from: { email: 'a@x.dev', name },
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      });
      expect(unfoldHeader(viaString.text, 'From')).toBe(`${rendered} <a@x.dev>`);
      expect(unfoldHeader(viaObject.text, 'From')).toBe(`${rendered} <a@x.dev>`);
      // Read the quoted-string back the way a receiver does.
      const m = unfoldHeader(viaString.text, 'From').match(/^"((?:[^"\\]|\\.)*)" </);
      if (m) {
        expect(m[1].replace(/\\(.)/g, '$1')).toBe(name);
      }
    }
    // A non-ASCII name becomes encoded-words rather than a quoted-string;
    // the decoded text is what gets encoded.
    const { text } = await build({
      from: '"\\"😀\\\\ ï" <a@x.dev>',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
    });
    expect(decodeEncodedWords(unfoldHeader(text, 'From'))).toBe('"😀\\ ï <a@x.dev>');
  });

  describe('a period in a display name', () => {
    // `.` is one of RFC 5322 §3.2.3's `specials`, so an unquoted dotted name
    // parses only as `obs-phrase` (§4.1), which §4 says MUST NOT be generated.
    const dotted: Array<[string, string]> = [
      ['Dr. Smith', '"Dr. Smith"'],
      ['J. R. R. Tolkien', '"J. R. R. Tolkien"'],
      ['Smith.', '"Smith."'],
      ['.', '"."'],
      ['Acme Inc.', '"Acme Inc."'],
    ];

    it('renders the name as one quoted-string, in From and in an address list', async () => {
      for (const [name, rendered] of dotted) {
        const { text } = await build({
          from: { email: 'a@x.dev', name },
          to: [{ email: 'b@y.dev', name }, 'c@z.dev'],
          subject: 's',
          text: 'hi',
        });
        expect(unfoldHeader(text, 'From')).toBe(`${rendered} <a@x.dev>`);
        expect(unfoldHeader(text, 'To')).toBe(`${rendered} <b@y.dev>, c@z.dev`);
      }
    });

    it('renders the string form the same way, whether or not the caller quoted it', async () => {
      for (const [name, rendered] of dotted) {
        const bare = await build({
          from: `${name} <a@x.dev>`,
          to: 'b@y.dev',
          subject: 's',
          text: 't',
        });
        const quoted = await build({
          from: `${rendered} <a@x.dev>`,
          to: 'b@y.dev',
          subject: 's',
          text: 't',
        });
        expect(unfoldHeader(bare.text, 'From')).toBe(`${rendered} <a@x.dev>`);
        expect(unfoldHeader(quoted.text, 'From')).toBe(`${rendered} <a@x.dev>`);
      }
    });

    it('round-trips through postal-mime as the original name', async () => {
      const { default: PostalMime } = await import('postal-mime');
      for (const [name] of dotted) {
        const { raw } = await build({
          from: { email: 'a@x.dev', name },
          to: { email: 'b@y.dev', name },
          subject: 's',
          text: 'hi',
        });
        const parsed = await PostalMime.parse(raw);
        expect(parsed.from).toEqual({ address: 'a@x.dev', name });
        expect(parsed.to).toEqual([{ address: 'b@y.dev', name }]);
      }
    });

    it('still escapes a quote or backslash beside the period', async () => {
      // The period only selects the quoted-string path; inside it `"` and
      // `\` are quoted-pairs as before, and the period itself is `qtext`.
      const { default: PostalMime } = await import('postal-mime');
      const name = 'Dr. "Doc" Smith \\ Jr.';
      const { raw, text } = await build({
        from: { email: 'a@x.dev', name },
        to: 'b@y.dev',
        subject: 's',
        text: 'hi',
      });
      expect(unfoldHeader(text, 'From')).toBe('"Dr. \\"Doc\\" Smith \\\\ Jr." <a@x.dev>');
      expect((await PostalMime.parse(raw)).from).toEqual({ address: 'a@x.dev', name });
    });

    it('leaves a non-ASCII dotted name to the encoded-word path', async () => {
      // `ASCII_PRINTABLE` is tested first: an encoded-word carries the
      // period as base64, so quoting it as well would put the quotes inside
      // the encoded text, not around it.
      const { text } = await build({
        from: { email: 'a@x.dev', name: 'Dr. Müller' },
        to: 'b@y.dev',
        subject: 's',
        text: 'hi',
      });
      const from = unfoldHeader(text, 'From');
      expect(from).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@x\.dev>$/);
      expect(decodeEncodedWords(from)).toBe('Dr. Müller <a@x.dev>');
    });

    it('is bounded by the quoted-string line guard, at the same edge as any other special', async () => {
      // A quoted-string is one token `foldHeader` never splits: 995 characters
      // fit a 998-octet line exactly (the period is `qtext`), 996 do not.
      const fits = `Dr. ${'a'.repeat(998 - 3 - 4)}`;
      expect(fits.length).toBe(995);
      const { text } = await build({
        from: 'a@x.dev',
        to: { email: 'b@y.dev', name: fits },
        subject: 's',
        text: 't',
      });
      const lines = headerLines(text, 'To');
      expect(lines).toEqual(['To:', ` "${fits}"`, ' <b@y.dev>']);
      expect(Math.max(...lines.map((l) => l.length))).toBe(998);
      await expect(
        build({
          from: 'a@x.dev',
          to: { email: 'b@y.dev', name: `${fits}b` },
          subject: 's',
          text: 't',
        }),
      ).rejects.toThrow(
        /to: display name is 996 characters and must be quoted, which cannot be folded/,
      );
    });
  });

  it('rejects an addr-spec glued to an angle-bracket address', async () => {
    await expect(
      normalizeEmail({ from: 'a@x.dev<b@evil.dev>', to: 'b@y.dev', subject: 's', text: 't' }),
    ).rejects.toThrow(/from/);
  });

  it('rejects unbalanced quotes around display name', async () => {
    await expect(
      normalizeEmail({
        from: '"Acme <a@x.dev>',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/from/);
  });

  it('drops user-supplied In-Reply-To and References (only `threading` sets them)', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      headers: {
        'In-Reply-To': '<spoof-thread@evil.dev>',
        References: '<spoof-references@evil.dev>',
      },
    });
    expect(text).not.toContain('spoof-thread');
    expect(text).not.toContain('spoof-references');
  });

  describe('threading option', () => {
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 'Re: s', text: 't' };

    it('renders In-Reply-To and References after Message-ID', async () => {
      const { text } = await build({
        ...base,
        threading: { inReplyTo: '<parent@x.dev>', references: '<root@x.dev> <parent@x.dev>' },
      });
      expect(text).toMatch(
        /Message-ID: <[^>]+>\r\nIn-Reply-To: <parent@x\.dev>\r\nReferences: <root@x\.dev> <parent@x\.dev>\r\n/,
      );
    });

    it('defaults References to In-Reply-To', async () => {
      const email = await normalizeEmail({ ...base, threading: { inReplyTo: ' <parent@x.dev> ' } });
      expect(email.threading).toEqual({
        inReplyTo: '<parent@x.dev>',
        references: '<parent@x.dev>',
      });
    });

    it('still sends when a stray quote stops the folder from breaking the line', async () => {
      // Inside a quoted string `foldHeader` cannot fold at a space, so the
      // whole rest of the value is one run.
      const quotedChain = `<"a@x> ${'<b@x.com> '.repeat(200)}<p@x>`;
      for (const threading of [
        { inReplyTo: '<p@x>', references: quotedChain },
        { inReplyTo: `"${' a'.repeat(600)}` },
      ]) {
        const email = await normalizeEmail({ ...base, threading });
        const text = decode(buildMime(email).raw);
        expect(text).not.toContain('<"a@x>');
        expect(text).not.toContain('In-Reply-To: "');
      }
      const fallback = await normalizeEmail({
        ...base,
        threading: { inReplyTo: '<p@x>', references: quotedChain },
      });
      expect(fallback.threading).toEqual({ inReplyTo: '<p@x>', references: '<p@x>' });
    });

    it('trims only spaces and tabs from inReplyTo', async () => {
      const email = await normalizeEmail({
        ...base,
        threading: { inReplyTo: '\t <p@x.dev>\u00a0 ' },
      });
      expect(email.threading?.inReplyTo).toBe('<p@x.dev>\u00a0');
    });

    it('leaves out an id that holds a control character or cannot fit a line, and still sends', async () => {
      for (const inReplyTo of [
        '<a\r\nBcc: x@evil.dev>',
        '<a\u0001@x>',
        `<${'x'.repeat(1000)}@x>`,
      ]) {
        const email = await normalizeEmail({ ...base, threading: { inReplyTo } });
        expect(email.threading).toBeUndefined();
        expect(decode(buildMime(email).raw)).not.toContain('In-Reply-To');
      }
      const email = await normalizeEmail({
        ...base,
        threading: {
          inReplyTo: '<parent@x.dev>',
          references: '<root@x.dev> <bad\u007f@x> <parent@x.dev>',
        },
      });
      expect(email.threading).toEqual({
        inReplyTo: '<parent@x.dev>',
        references: '<root@x.dev> <parent@x.dev>',
      });
      // A chain with an id too long for one line falls back to the parent.
      const long = await normalizeEmail({
        ...base,
        threading: { inReplyTo: '<parent@x.dev>', references: `<${'x'.repeat(1000)}@x>` },
      });
      expect(long.threading).toEqual({ inReplyTo: '<parent@x.dev>', references: '<parent@x.dev>' });
    });

    it('keeps the newest whole ids of a References chain over 8 KiB', async () => {
      const ids = Array.from(
        { length: 1000 },
        (_, i) => `<id-${String(i).padStart(4, '0')}@x.dev>`,
      );
      const email = await normalizeEmail({ ...base, threading: { references: ids.join(' ') } });
      const kept = email.threading!.references!;
      expect(kept.length).toBeLessThanOrEqual(8192);
      expect(kept.endsWith('<id-0999@x.dev>')).toBe(true);
      expect(ids.join(' ').endsWith(kept)).toBe(true);
      expect(kept.startsWith('<id-')).toBe(true);
    });

    it('rejects a value that is not a string', async () => {
      for (const threading of [
        '<parent@x.dev>',
        null,
        { inReplyTo: 5 },
        { references: ['<a@x>'] },
      ]) {
        await expect(
          normalizeEmail({ ...base, threading } as unknown as Parameters<typeof normalizeEmail>[0]),
        ).rejects.toMatchObject({ code: 'MIME_ERROR' });
      }
    });

    it('treats empty values as no threading', async () => {
      const email = await normalizeEmail({
        ...base,
        threading: { inReplyTo: '', references: '  ' },
      });
      expect(email.threading).toBeUndefined();
    });
  });

  it('folds long whitespace-separated headers (e.g. References) below 78 columns', async () => {
    // 30 message IDs without commas: the fold must split at whitespace, not
    // only at address-list separators.
    const ids: Array<string> = [];
    for (let i = 0; i < 30; i++) {
      ids.push(`<msg-${i.toString().padStart(3, '0')}@example.com>`);
    }
    const refs = ids.join(' ');
    const { raw } = buildMime(
      await normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        threading: { references: refs, inReplyTo: ids[ids.length - 1] },
      }),
    );
    const text = new TextDecoder().decode(raw);
    const lines = text.split('\r\n');
    // Find the References line + any continuations (lines starting with
    // a single SP — RFC 5322 folding marker).
    const refIdx = lines.findIndex((l) => l.startsWith('References: '));
    expect(refIdx).toBeGreaterThanOrEqual(0);
    const collected: Array<string> = [lines[refIdx]];
    for (let i = refIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith(' ') || lines[i].startsWith('\t')) {
        collected.push(lines[i]);
      } else {
        break;
      }
    }
    // Every physical line stays under RFC 5322's 998-octet limit and
    // also under our soft 78-octet target (we cap at ~76).
    for (const l of collected) {
      expect(l.length).toBeLessThanOrEqual(78);
    }
    // All 30 message IDs survive intact across the fold.
    const merged = collected.map((l, i) => (i === 0 ? l : l.trimStart())).join(' ');
    for (const id of ids) {
      expect(merged).toContain(id);
    }
    expect(collected.length).toBeGreaterThan(1); // actually folded
  });

  it('header-folds long address lists at unquoted comma boundaries only', async () => {
    // Construct a To list with quoted names containing commas, so that a
    // naive split-on-`, ` fold would corrupt the rendered headers. Verify
    // that all four addresses still render intact.
    const { text } = await build({
      from: 'a@x.dev',
      to: [
        { email: 'one@y.dev', name: 'Smith, John' },
        { email: 'two@y.dev', name: 'Doe, Jane' },
        { email: 'three@y.dev', name: 'Bob' },
        { email: 'four@y.dev', name: 'Roe, Mary' },
      ],
      subject: 's',
      text: 't',
    });
    expect(text).toContain('"Smith, John" <one@y.dev>');
    expect(text).toContain('"Doe, Jane" <two@y.dev>');
    expect(text).toContain('Bob <three@y.dev>');
    expect(text).toContain('"Roe, Mary" <four@y.dev>');
  });

  it('caps every RFC 2047 encoded-word at 75 characters', async () => {
    // 16 CJK characters are 48 UTF-8 bytes. Encoded as one unbounded
    // word that is `=?UTF-8?B?` (10) + base64(48) (64) + `?=` (2) = 76
    // characters — one over RFC 2047 §2's 75-character ceiling. The
    // ceiling leaves 63 base64 characters, so 45 source bytes is the
    // largest payload that fits.
    const subject = '日本語のメールを送信します。テス';
    expect([...subject]).toHaveLength(16);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject,
      text: 't',
    });
    const value = unfoldHeader(text, 'Subject');
    const words = encodedWords(value);
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeEncodedWords(value)).toBe(subject);
  });

  it('folds a long non-ASCII subject under RFC 5322 §2.1.1 (998 octets)', async () => {
    // Unfolded, 246 CJK characters are one 1005-octet line, past RFC 5322
    // §2.1.1's 998-octet MUST.
    const subject = '日本語'.repeat(82);
    expect([...subject]).toHaveLength(246);
    const { raw, text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject,
      text: 't',
    });
    // Measure octets, not UTF-16 units — the limit is on the wire form.
    const encoder = new TextEncoder();
    for (const line of text.split('\r\n')) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(998);
    }
    const lines = headerLines(text, 'Subject');
    expect(lines.length).toBeGreaterThan(1); // actually folded
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    const value = unfoldHeader(text, 'Subject');
    for (const word of encodedWords(value)) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeEncodedWords(value)).toBe(subject);
    expect(raw.byteLength).toBeGreaterThan(0);
  });

  it('folds long non-ASCII display names in From and in address lists', async () => {
    // Display names run through the same encoder; the recipient list also
    // exercises the address-list fold branch.
    const name = '株式会社ボイドゼロの営業部'.repeat(20);
    const { text } = await build({
      from: { email: 'j@x.dev', name },
      to: [
        // A quoted display name whose own comma must survive the fold.
        { email: 'one@y.dev', name: 'Smith, John' },
        { email: 'two@y.dev', name },
        { email: 'three@y.dev', name: 'Bob' },
      ],
      subject: 's',
      text: 't',
    });
    const encoder = new TextEncoder();
    for (const line of text.split('\r\n')) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(998);
    }
    for (const header of ['From', 'To']) {
      const value = unfoldHeader(text, header);
      for (const word of encodedWords(value)) {
        expect(word.length).toBeLessThanOrEqual(75);
      }
    }
    expect(decodeEncodedWords(unfoldHeader(text, 'From'))).toBe(`${name} <j@x.dev>`);
    expect(decodeEncodedWords(unfoldHeader(text, 'To'))).toBe(
      `"Smith, John" <one@y.dev>, ${name} <two@y.dev>, Bob <three@y.dev>`,
    );
  });

  it('never splits an astral character across encoded-words', async () => {
    // RFC 2047 §5: "A multi-octet character may not be split across
    // adjacent encoded-words." A chunker that counted UTF-16 units — or
    // that base64'd once and sliced the output — would cut a 4-byte
    // emoji in half, and each half would decode to U+FFFD. Sweep the
    // leading padding so the astral run crosses the chunk boundary at
    // every possible byte offset.
    for (let pad = 0; pad < 8; pad++) {
      const subject = `${'x'.repeat(pad)}é🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉𠮷𠮷ok`;
      const { text } = await build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject,
        text: 't',
      });
      const value = unfoldHeader(text, 'Subject');
      const decoded = decodeEncodedWords(value);
      expect(decoded).not.toContain('�');
      expect(decoded).toBe(subject);
    }
  });

  it('keeps folding long ASCII header values at whitespace (control)', async () => {
    // Pure-ASCII values never reach the encoder; they fold at whitespace.
    const words: Array<string> = [];
    for (let i = 0; i < 40; i++) {
      words.push(`word${i.toString().padStart(3, '0')}`);
    }
    const subject = words.join(' ');
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject,
      text: 't',
    });
    const lines = headerLines(text, 'Subject');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    expect(encodedWords(unfoldHeader(text, 'Subject'))).toHaveLength(0);
    expect(unfoldHeader(text, 'Subject')).toBe(subject);
  });
});

function bodyOf(text: string): string {
  return text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
}

describe('buildMime body size projection', () => {
  // A 4 MiB non-ASCII body is 12.6 MiB once quoted-printable encoded, so the
  // projection refuses it before encoding.
  it('rejects a body that cannot fit before encoding it', async () => {
    const cjk = '漢'.repeat(Math.ceil((4 * 1024 * 1024) / 3));
    const email = await normalizeEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: cjk });
    let error: unknown;
    try {
      buildMime(email);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MimeError);
    expect((error as MimeError).code).toBe('MIME_ERROR');
    // The projection's message, not the post-render one: the body was never encoded.
    expect((error as MimeError).message).toMatch(
      new RegExp(
        `at least \\d+ bytes once encoded, which exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes`,
      ),
    );
  });

  it('counts text and html together', async () => {
    // Each alone projects under the limit; together they cannot fit.
    const half = '漢'.repeat(Math.ceil((0.9 * 1024 * 1024) / 3));
    await expect(
      build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: half }),
    ).resolves.toBeTruthy();
    await expect(
      build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: half, html: half }),
    ).rejects.toThrow(/at least \d+ bytes once encoded/);
  });

  it('never rejects a message that fits, and leaves the final check as the authority', async () => {
    // The projection ignores soft breaks and headers, so this body projects
    // under the cap but renders over it: the post-render check must refuse it.
    // One full render, so it carries its own timeout.
    const nearly = '漢'.repeat(Math.ceil((1.65 * 1024 * 1024) / 3));
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: nearly,
    });
    expect(() => buildMime(email)).toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    // And a body the projection accepts builds; the size that fits is not
    // at issue, so keep this one small.
    const fits = '漢'.repeat(20_000);
    const { raw } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: fits });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  }, 30_000);
});

describe('buildMime header size projection', () => {
  const PROJECTION = new RegExp(
    `message is at least \\d+ bytes once encoded, which exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes`,
  );

  async function expectProjected(
    opts: Parameters<typeof normalizeEmail>[0],
    threading?: Threading,
  ) {
    const email = threading
      ? await normalizeWithThreading(opts, threading)
      : await normalizeEmail(opts);
    let error: unknown;
    try {
      buildMime(email);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MimeError);
    expect((error as MimeError).code).toBe('MIME_ERROR');
    // The projection's message, not the post-render one: nothing was encoded.
    expect((error as MimeError).message).toMatch(PROJECTION);
  }

  // A non-ASCII header value is B-encoded into 45-byte words of 72 octets
  // each and folded one per line: 5 octets for every CJK character.
  it('rejects a subject that cannot fit before encoding it', async () => {
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: '漢'.repeat(3_000_000),
      text: 'hi',
    });
  });

  it('counts every display name across the recipient list', async () => {
    await expectProjected({
      from: 'a@x.dev',
      to: Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({
        email: `u${i}@y.dev`,
        name: '漢'.repeat(30_000),
      })),
      subject: 's',
      text: 'hi',
    });
  });

  it('bounds aggregate custom headers by their encoded and folded wire size', async () => {
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 'hi' };
    await expect(
      normalizeEmail({ ...base, headers: { 'X-Note': 'x'.repeat(16 * 1024) } }),
    ).rejects.toThrow('16 KiB');
    // 15,000 input bytes expand to more than 25 KiB of RFC 2047 words and
    // folded continuation lines. The proxy measures the latter.
    const unicode = '漢'.repeat(5000);
    expect(new TextEncoder().encode(unicode)).toHaveLength(15_000);
    await expect(normalizeEmail({ ...base, headers: { 'X-Note': unicode } })).rejects.toThrow(
      '16 KiB',
    );
    // These two fields occupy under 16 KiB before rendering, but folding
    // replaces enough spaces with CRLF + SPACE to cross the wire limit.
    const foldedValue = 'word '.repeat(1595).trimEnd();
    const foldedHeaders = { 'X-One': foldedValue, 'X-Two': foldedValue };
    const inputBytes = Object.entries(foldedHeaders).reduce(
      (sum, [name, value]) => sum + name.length + new TextEncoder().encode(value).byteLength + 4,
      0,
    );
    expect(inputBytes).toBeLessThan(16 * 1024);
    await expect(normalizeEmail({ ...base, headers: foldedHeaders })).rejects.toThrow('16 KiB');
    const names = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`X${i}`.padEnd(500, 'a'), '']),
    );
    await expect(normalizeEmail({ ...base, headers: names })).rejects.toThrow('16 KiB');
    const { text } = await build({ ...base, headers: { 'X-Note': 'short note' } });
    expect(text).toContain('X-Note: short note');
  });

  it('never charges the whitespace that folding collapses', async () => {
    // `foldHeader` re-joins a long value from its non-WSP tokens, so 11 MiB
    // of spaces renders as one. A bound that counted `length` would reject
    // this message; it fits.
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: `a${' '.repeat(11 * 1024 * 1024)}b`,
      text: 'hi',
    });
    expect(text).toContain('Subject: a b\r\n');
  });

  // `replyEmail` copies the threading headers off the inbound message, so a
  // remote sender controls their size.
  it('counts the threading headers', async () => {
    // 900k twelve-character ids: 10.8 MB of non-WSP before a single space.
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 'hi' };
    await expectProjected(base, { references: '<abcdefgh@x> '.repeat(900_000).trimEnd() });
    await expectProjected(base, { inReplyTo: `<${'x'.repeat(11 * 1024 * 1024)}@x>` });
  });

  // `normalizeAttachment` bounds the Content-ID, so the charge is pinned on a
  // hand-built email: `buildMime` is the authority on the final size.
  it('counts an attachment Content-ID on a hand-built email', () => {
    const over = 'x'.repeat(11 * 1024 * 1024);
    expect(() =>
      buildMime({
        from: { email: 'a@x.dev' },
        to: [{ email: 'b@y.dev' }],
        cc: [],
        bcc: [],
        subject: 's',
        text: 'hi',
        headers: {},
        attachments: [
          {
            filename: 'f.txt',
            contentType: 'text/plain',
            bytes: new Uint8Array(1),
            contentId: over,
            disposition: 'inline',
          },
        ],
      }),
    ).toThrow(PROJECTION);
  });

  // `normalizeAttachment` bounds one filename, not the sum, so every part is
  // charged its filename twice plus the framing around it.
  it('counts every attachment part: its filename twice, and the framing around it', async () => {
    const filename = 'a'.repeat(986);
    const empty = new Uint8Array(0);
    const parts = (n: number) =>
      Array.from({ length: n }, () => ({ filename, contentType: 'a/b', content: empty }));
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: parts(25_000),
    });
    // The bound is exact for a part with no content: these project under the
    // cap and render over it, so the post-render check refuses them.
    await expect(
      build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't', attachments: parts(2_506) }),
    ).rejects.toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    // And a few parts fewer build.
    const { raw } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: parts(2_450),
    });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it('never rejects a References chain that fits, and never charges the whitespace it folds away', async () => {
    // A chain of short ids under the cap folds at its spaces and renders.
    const id = '<abcdefgh@x>';
    const chain = Array.from(
      { length: Math.floor((2.5 * 1024 * 1024) / (id.length + 1)) },
      () => id,
    );
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 'hi' };
    const raw = buildMime(await normalizeWithThreading(base, { references: chain.join(' ') })).raw;
    const text = decode(raw);
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(unfoldHeader(text, 'References')).toBe(chain.join(' '));
    // A long chain is re-joined from its ids by single spaces, so 11 MiB of
    // spaces between two ids renders as one; a bound that charged them
    // would reject a message that fits.
    const spaced = decode(
      buildMime(
        await normalizeWithThreading(base, {
          references: `<a@x>${' '.repeat(11 * 1024 * 1024)}<b@x>`,
        }),
      ).raw,
    );
    expect(spaced).toContain('References: <a@x> <b@x>\r\n');
  });

  it('never rejects a header-heavy message that fits, and leaves the final check as the authority', async () => {
    // The projection charges 4.8 octets per CJK character (it omits the fold's
    // CRLF per word) against 5 rendered, so this subject projects under the cap
    // but renders over it. One full render, so it carries its own timeout.
    const nearly = '漢'.repeat(1_075_000);
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: nearly,
      text: 'hi',
    });
    expect(() => buildMime(email)).toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    // And a subject the projection accepts builds; the size that fits is
    // not at issue, so keep this one small.
    const fits = '漢'.repeat(20_000);
    const { raw } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: fits, text: 'hi' });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  }, 30_000);
});

describe('foldHeader memory', () => {
  // A legal subject of 1.5M fold points. The runner's heap is not the
  // isolate's, so this pins the rendered shape, not the memory.
  it('folds a legal subject of millions of one-letter words', async () => {
    const words = 1_500_000;
    const { raw, text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 'a '.repeat(words).trimEnd(),
      text: 'hi',
    });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const lines = headerLines(text, 'Subject');
    expect(lines[0]).toBe(`Subject:${' a'.repeat(34)}`);
    expect(lines.every((l) => l.length <= 76)).toBe(true);
    expect(unfoldHeader(text, 'Subject')).toBe('a '.repeat(words).trimEnd());
  });
});

describe('body line scan memory', () => {
  // A legal body of millions of short lines. The runner's heap is not the
  // isolate's, so this pins the rendered shape and that the scans stay linear.
  it('builds a legal message of millions of short lines in text and html', async () => {
    const lines = 750_000;
    const started = performance.now();
    const { raw, text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'a\n'.repeat(lines),
      html: '\n'.repeat(lines),
    });
    // A gross-regression guard only.
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(raw.byteLength).toBeGreaterThan(lines * 5);
    expect(text).toContain(`Content-Transfer-Encoding: 7bit\r\n\r\n${'a\r\n'.repeat(lines)}`);
    expect(text).toContain(`Content-Transfer-Encoding: 7bit\r\n\r\n${'\r\n'.repeat(lines)}`);
    // Every LF in the message is the LF of a CRLF.
    expect(text).not.toMatch(/(^|[^\r])\n/);
  });
});

describe('quotedPrintable encoder', () => {
  const cases: Array<[string, string, string]> = [
    [
      'soft-breaks at 76 columns',
      'é'.repeat(30),
      '=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=\r\n=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=\r\n=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9',
    ],
    ['quotes trailing whitespace', 'a \nb\t\nc é', 'a=20\r\nb=09\r\nc =C3=A9'],
    ['quotes control bytes and =', 'a\u0001b=é', 'a=01b=3D=C3=A9'],
    ['normalizes CR, LF and CRLF', 'l1\r\nl2\rl3\nl4é', 'l1\r\nl2\r\nl3\r\nl4=C3=A9'],
    [
      'does not split a quoted byte across a soft break',
      'a'.repeat(100) + 'é',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\r\naaaaaaaaaaaaaaaaaaaaaaaaa=C3=A9',
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(name, async () => {
      const { text } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: input });
      expect(text).toContain('Content-Transfer-Encoding: quoted-printable');
      expect(bodyOf(text)).toBe(expected);
    });
  }
});
