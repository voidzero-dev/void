/**
 * Secret redaction (spec §7.3): stored secret values become `[REDACTED:NAME]` before any
 * input is written. Only values of 8+ characters with two character classes (edge #30),
 * in four forms (raw, JSON-escaped, base64, URL-encoded), longest first, no regex.
 * M31: `hitsIn` says where each secret was, for ingest's `secret-in-output` findings.
 */

export type SecuritySecret = Readonly<{ name: string; value: string }>;

export const SECURITY_REDACT_MIN_LENGTH = 8;

export function isRedactableSecret(value: string): boolean {
  if (value.length < SECURITY_REDACT_MIN_LENGTH) {
    return false;
  }
  const kinds = new Set<string>();
  for (const char of value) {
    kinds.add(
      char >= 'a' && char <= 'z'
        ? 'a'
        : char >= 'A' && char <= 'Z'
          ? 'A'
          : char >= '0' && char <= '9'
            ? '0'
            : '.',
    );
  }
  return kinds.size >= 2;
}

function base64(value: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(''),
  );
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
  hits(): number;
  /** Where the secrets are in a text, each once, in line order; reads only. */
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
      // Longest first, as `redact`: a taken range is not matched again. Taken ranges are
      // kept sorted, so each needle walks them once with its matches.
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
