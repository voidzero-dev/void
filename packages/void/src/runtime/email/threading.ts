/**
 * Header-value checks shared by the MIME builder and the reply path, and the
 * best-effort cleaning of `In-Reply-To` / `References` ids. Thread ids usually
 * come from remote mail, so an id that cannot be sent is left out instead of
 * failing the message. No imports, so both `mime.ts` and `inbound.ts` can use it.
 */

/**
 * Index of the first C0 control other than HTAB, or DEL; -1 when there is
 * none. HTAB is folding whitespace (RFC 5322 §3.2.2).
 */
export function indexOfControl(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      return i;
    }
  }
  return -1;
}

/**
 * `value` without leading or trailing SP and HTAB, the only whitespace a
 * `Headers` value is trimmed of. `String#trim` would also strip U+00A0.
 */
export function trimFws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charCodeAt(start) === 0x20 || value.charCodeAt(start) === 0x09)) {
    start++;
  }
  while (
    end > start &&
    (value.charCodeAt(end - 1) === 0x20 || value.charCodeAt(end - 1) === 0x09)
  ) {
    end--;
  }
  return value.slice(start, end);
}

/**
 * Whether `Name: value` fits RFC 5322's 998-octet line once folded. It
 * follows `foldHeader`: a fold point is SP or HTAB outside a quoted string,
 * so the widest run between fold points decides.
 */
export function fitsHeaderLine(name: string, value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  // One pass without allocation: tokenizing a hostile 10 MiB header could
  // exhaust the isolate. Other `\s` characters do not end a run, because
  // `foldHeader` cannot fold at them.
  const budget = 998 - (name.length + 2);
  let run = 0;
  let inQuotes = false;
  let escape = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (escape) {
      escape = false;
    } else if (c === 0x5c && inQuotes) {
      escape = true;
    } else if (c === 0x22) {
      inQuotes = !inQuotes;
    } else if ((c === 0x20 || c === 0x09) && !inQuotes) {
      run = 0;
      continue;
    }
    // UTF-8 octets: a surrogate pair is 4, a lone surrogate (U+FFFD) is 3.
    if (c < 0x80) {
      run += 1;
    } else if (c < 0x800) {
      run += 2;
    } else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < value.length &&
      (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      run += 4;
      i++;
    } else {
      run += 3;
    }
    if (run > budget) {
      return false;
    }
  }
  return true;
}

/**
 * Longest `References` value, in UTF-16 code units. 8 KiB keeps any real
 * thread whole; past it the newest ids are kept, since mail clients thread on
 * any id they recognise and the parent is `In-Reply-To`.
 */
const MAX_REFERENCES_CHARS = 8192;

/**
 * The newest whole ids of `chain` that fit `budget` code units, without the
 * ids that hold a control character.
 */
function newestIds(chain: string, budget: number): string {
  if (chain.length > budget) {
    // Cut at the next SP or HTAB so no id is split.
    let cut = chain.length - budget;
    while (cut < chain.length) {
      const c = chain.charCodeAt(cut);
      if (c === 0x20 || c === 0x09) {
        break;
      }
      cut++;
    }
    chain = chain.slice(cut);
  }
  // After the cut, so the walk is bounded.
  return dropControlIds(chain);
}

/** `chain` without the ids that hold a control character, joined by single spaces. */
function dropControlIds(chain: string): string {
  if (indexOfControl(chain) === -1) {
    return chain;
  }
  const kept: Array<string> = [];
  let start = -1;
  let tainted = false;
  for (let i = 0; i <= chain.length; i++) {
    const c = i < chain.length ? chain.charCodeAt(i) : 0x20;
    if (c === 0x20 || c === 0x09) {
      if (start >= 0 && !tainted) {
        kept.push(chain.slice(start, i));
      }
      start = -1;
      tainted = false;
    } else {
      if (start < 0) {
        start = i;
      }
      if (c < 0x20 || c === 0x7f) {
        tainted = true;
      }
    }
  }
  return kept.join(' ');
}

/** `id` when it fits one `name:` line and holds no control character, else `''`. */
export function threadingId(name: string, id: string): string {
  return fitsHeaderLine(name, id) && indexOfControl(id) === -1 ? id : '';
}

/** `References` cut to its newest whole ids, or `''` when an id cannot fit a line. */
export function threadingReferences(chain: string): string {
  const kept = newestIds(chain, MAX_REFERENCES_CHARS).trim();
  return fitsHeaderLine('References', kept) ? kept : '';
}

/**
 * A reply's `References`, or `''`: the inbound chain plus the parent's id,
 * trimmed to its newest whole ids, or the parent's id alone when an id
 * cannot fit a line. `messageId` was already checked with `threadingId`.
 */
export function replyReferences(originalReferences: string, messageId: string): string {
  const parent = messageId ? ` ${messageId}` : '';
  const chain =
    `${newestIds(originalReferences, MAX_REFERENCES_CHARS - parent.length)}${parent}`.trim();
  return fitsHeaderLine('References', chain) ? chain : messageId;
}
