/**
 * Text aimed at AI reviewers (spec §10.3). Before the model starts, the server
 * runs a plain substring match (no regex) on the changed files against a fixed
 * phrase list. Each file with a hit becomes one server lead, whatever the model
 * outputs: `Text aimed at AI reviewers in <file>`.
 *
 * Matching is case-insensitive and needs a word edge on both sides, so `llm` in
 * `smallMap` is not a hit. `LLM` alone must be upper case: lower case `llm` is
 * too common inside identifiers.
 */

import type { SecuritySecretForm } from './redact.ts';

export const SECURITY_REVIEWER_PHRASES: ReadonlyArray<string> = [
  'ignore previous',
  'ignore all previous',
  'ignore the previous',
  'disregard previous',
  'disregard all previous',
  'ai reviewer',
  'ai scanner',
  'ai auditor',
  'security scanner',
  'security reviewer',
  'report nothing',
  'do not report',
  "don't report",
  'no vulnerabilities here',
  'system prompt',
  'you are an ai',
];

/** Upper-case tokens matched as written. */
const CASE_SENSITIVE_TOKENS: ReadonlyArray<string> = ['LLM'];

/** At most this many hits are kept per file. */
const MAX_HITS_PER_FILE = 20;

export type SecurityPhraseHit = Readonly<{ phrase: string; line: number }>;

export type SecurityReviewerTextLead = Readonly<{
  kind: 'reviewer_text';
  title: string;
  file: string;
  hits: ReadonlyArray<SecurityPhraseHit>;
}>;

/**
 * M31: a stored project secret value found in the deployed output (the redactor's
 * hit, spec §7.3). Names the secret, never its value. One lead per secret and side:
 * `client` is a deployed static asset, otherwise Worker code. `file` and `line` are
 * the first place it was found; `alsoIn` lists a few more files, `files` counts them all.
 */
export type SecuritySecretLead = Readonly<{
  kind: 'secret_in_output';
  file: string;
  secret: string;
  forms: ReadonlyArray<SecuritySecretForm>;
  line: number;
  client: boolean;
  alsoIn?: ReadonlyArray<string>;
  files?: number;
}>;

/** What the server finds itself, whatever the model outputs. */
export type SecurityServerLead = SecurityReviewerTextLead | SecuritySecretLead;

/** `charCodeAt` past either end is NaN, which is not a word character. */
function isWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

function lineAt(offset: number, lineStarts: ReadonlyArray<number>): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid]! <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

function find(
  haystack: string,
  needle: string,
  original: string,
  lineStarts: ReadonlyArray<number>,
  hits: Array<SecurityPhraseHit>,
  reported: string,
): void {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1 || hits.length >= MAX_HITS_PER_FILE) {
      return;
    }
    const before = original.charCodeAt(at - 1);
    const after = original.charCodeAt(at + needle.length);
    if (!isWordChar(before) && !isWordChar(after)) {
      hits.push({ phrase: reported, line: lineAt(at, lineStarts) });
    }
    from = at + needle.length;
  }
}

export function findReviewerPhrases(text: string): Array<SecurityPhraseHit> {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 0x0a) {
      lineStarts.push(index + 1);
    }
  }
  // The phrases are ASCII. When lower-casing changes the length (a few non-ASCII
  // letters do), offsets would not line up, so that text is matched as written.
  const lowered = text.toLowerCase();
  const lower = lowered.length === text.length ? lowered : text;
  const hits: Array<SecurityPhraseHit> = [];
  for (const phrase of SECURITY_REVIEWER_PHRASES) {
    find(lower, phrase, text, lineStarts, hits, phrase);
  }
  for (const token of CASE_SENSITIVE_TOKENS) {
    find(text, token, text, lineStarts, hits, token);
  }
  return hits.sort((left, right) => left.line - right.line);
}

/** One lead per changed file with a hit. */
export function reviewerTextLeads(
  files: ReadonlyArray<Readonly<{ path: string; text: string }>>,
): Array<SecurityReviewerTextLead> {
  const leads: Array<SecurityReviewerTextLead> = [];
  for (const file of files) {
    const hits = findReviewerPhrases(file.text);
    if (hits.length > 0) {
      leads.push({
        kind: 'reviewer_text',
        title: `Text aimed at AI reviewers in ${file.path}`,
        file: file.path,
        hits,
      });
    }
  }
  return leads;
}
