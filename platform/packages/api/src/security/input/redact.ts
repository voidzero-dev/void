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

/** The four forms of a value, each once; forms shorter than the minimum are left out. */
export function secretForms(value: string): Array<string> {
  const forms = new Set([
    value,
    JSON.stringify(value).slice(1, -1),
    base64(value),
    encodeURIComponent(value),
  ]);
  return [...forms].filter((form) => form.length >= SECURITY_REDACT_MIN_LENGTH);
}

type Needle = Readonly<{ form: string; name: string }>;

export type SecurityRedactor = Readonly<{
  redact(text: string): string;
  /** Distinct secrets replaced at least once so far. */
  hits(): number;
}>;

export function createSecurityRedactor(secrets: ReadonlyArray<SecuritySecret>): SecurityRedactor {
  const needles: Array<Needle> = [];
  for (const secret of secrets) {
    if (!isRedactableSecret(secret.value)) {
      continue;
    }
    for (const form of secretForms(secret.value)) {
      needles.push({ form, name: secret.name });
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
  };
}
