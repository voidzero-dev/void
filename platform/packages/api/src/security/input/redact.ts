/**
 * Secret redaction (spec §7.3). Before any input is written for the container,
 * the project's stored secret values are replaced with `[REDACTED:NAME]`.
 *
 * - Only values of 8+ characters with at least two of: lower case, upper case,
 *   digits, symbols. `true`, `admin`, `production` stay (edge #30).
 * - Each value is matched in four forms: raw, JSON-escaped (as inside
 *   `sourcesContent`), base64 and URL-encoded.
 * - Plain substring replacement, no regex. Longer values go first, so a value that
 *   contains another is replaced whole.
 * - M31: a file with a hit also says where (`hitsIn`): each secret once, with the forms
 *   seen and the first line. Ingest turns these into server findings
 *   (`secret-in-output`); the value itself is never kept.
 */

export type SecuritySecret = Readonly<{ name: string; value: string }>;

export const SECURITY_REDACT_MIN_LENGTH = 8;

export function isRedactableSecret(value: string): boolean {
  if (value.length < SECURITY_REDACT_MIN_LENGTH) {
    return false;
  }
  let lower = false;
  let upper = false;
  let digit = false;
  let symbol = false;
  for (const char of value) {
    if (char >= 'a' && char <= 'z') {
      lower = true;
    } else if (char >= 'A' && char <= 'Z') {
      upper = true;
    } else if (char >= '0' && char <= '9') {
      digit = true;
    } else {
      symbol = true;
    }
  }
  return Number(lower) + Number(upper) + Number(digit) + Number(symbol) >= 2;
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** How a value was written: as is, JSON-escaped, base64 or URL-encoded. */
export type SecuritySecretForm = 'raw' | 'json' | 'base64' | 'url';

export const SECURITY_SECRET_FORMS: ReadonlyArray<SecuritySecretForm> = [
  'raw',
  'json',
  'base64',
  'url',
];

/** The four forms of a value, by kind; a form equal to an earlier one or too short is left out. */
function secretFormsByKind(
  value: string,
): Array<Readonly<{ kind: SecuritySecretForm; form: string }>> {
  const all: Array<Readonly<{ kind: SecuritySecretForm; form: string }>> = [
    { kind: 'raw', form: value },
    { kind: 'json', form: JSON.stringify(value).slice(1, -1) },
    { kind: 'base64', form: base64(value) },
    { kind: 'url', form: encodeURIComponent(value) },
  ];
  const seen = new Set<string>();
  return all.filter((entry) => {
    if (entry.form.length < SECURITY_REDACT_MIN_LENGTH || seen.has(entry.form)) {
      return false;
    }
    seen.add(entry.form);
    return true;
  });
}

/** The four forms of a value, each once; forms shorter than the minimum are left out. */
export function secretForms(value: string): Array<string> {
  return secretFormsByKind(value).map((entry) => entry.form);
}

type Needle = Readonly<{ form: string; kind: SecuritySecretForm; name: string }>;

/** One secret found in one text: its name, the forms seen, the first line (1-based). */
export type SecuritySecretHit = Readonly<{
  name: string;
  forms: ReadonlyArray<SecuritySecretForm>;
  line: number;
}>;

export type SecurityRedactor = Readonly<{
  redact(text: string): string;
  /** Distinct secrets replaced at least once so far. */
  hits(): number;
  /**
   * Where the secrets are in a text (before redaction), each secret once, in line
   * order. A form inside a longer match (a longer secret, or another form) is not
   * counted again. Reads only; `hits()` does not change.
   */
  hitsIn(text: string): Array<SecuritySecretHit>;
}>;

function lineOf(text: string, offset: number): number {
  let line = 1;
  let at = text.indexOf('\n');
  while (at !== -1 && at < offset) {
    line++;
    at = text.indexOf('\n', at + 1);
  }
  return line;
}

export function createSecurityRedactor(secrets: ReadonlyArray<SecuritySecret>): SecurityRedactor {
  const needles: Array<Needle> = [];
  for (const secret of secrets) {
    if (!isRedactableSecret(secret.value)) {
      continue;
    }
    for (const { kind, form } of secretFormsByKind(secret.value)) {
      needles.push({ form, kind, name: secret.name });
    }
  }
  needles.sort((left, right) => right.form.length - left.form.length);
  const hit = new Set<string>();
  return {
    redact(text) {
      let out = text;
      for (const needle of needles) {
        if (out.includes(needle.form)) {
          out = out.split(needle.form).join(`[REDACTED:${needle.name}]`);
          hit.add(needle.name);
        }
      }
      return out;
    },
    hits: () => hit.size,
    hitsIn(text) {
      // Longest first, as `redact`: a range already taken is not matched again. Taken
      // ranges never overlap, so they are kept sorted (two flat lists) and each needle
      // walks them once with its matches: linear in the matches, however many there are.
      let starts: Array<number> = [];
      let stops: Array<number> = [];
      const found = new Map<string, { offset: number; forms: Set<SecuritySecretForm> }>();
      for (const needle of needles) {
        const newStarts: Array<number> = [];
        const newStops: Array<number> = [];
        let next = 0;
        let from = 0;
        for (;;) {
          const at = text.indexOf(needle.form, from);
          if (at === -1) {
            break;
          }
          const end = at + needle.form.length;
          while (next < starts.length && stops[next] <= at) {
            next++;
          }
          if (next >= starts.length || starts[next] >= end) {
            newStarts.push(at);
            newStops.push(end);
            const entry = found.get(needle.name);
            if (entry) {
              entry.forms.add(needle.kind);
              entry.offset = Math.min(entry.offset, at);
            } else {
              found.set(needle.name, { offset: at, forms: new Set([needle.kind]) });
            }
          }
          from = end;
        }
        if (newStarts.length > 0) {
          const mergedStarts: Array<number> = [];
          const mergedStops: Array<number> = [];
          let left = 0;
          let right = 0;
          while (left < starts.length || right < newStarts.length) {
            if (
              right >= newStarts.length ||
              (left < starts.length && starts[left] < newStarts[right])
            ) {
              mergedStarts.push(starts[left]);
              mergedStops.push(stops[left]);
              left++;
            } else {
              mergedStarts.push(newStarts[right]);
              mergedStops.push(newStops[right]);
              right++;
            }
          }
          starts = mergedStarts;
          stops = mergedStops;
        }
      }
      return [...found]
        .map(([name, entry]) => ({
          name,
          offset: entry.offset,
          forms: SECURITY_SECRET_FORMS.filter((form) => entry.forms.has(form)),
        }))
        .sort((left, right) => left.offset - right.offset || (left.name < right.name ? -1 : 1))
        .map((entry) => ({
          name: entry.name,
          forms: entry.forms,
          line: lineOf(text, entry.offset),
        }));
    },
  };
}
