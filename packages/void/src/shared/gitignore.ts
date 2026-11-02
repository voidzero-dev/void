import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';

/** Preserve existing rules and line endings; return only the entries we added. */
export function ensureGitignoreLines(
  root: string,
  lines: ReadonlyArray<string>,
  aliases: Readonly<Record<string, ReadonlyArray<string>>> = {},
): ReadonlyArray<string> {
  const path = join(root, '.gitignore');
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const existing = new Set(source.split(/\r?\n/).map((line) => line.trimEnd()));
  const missing = [...new Set(lines)].filter(
    (line) => !existing.has(line) && !aliases[line]?.some((alias) => existing.has(alias)),
  );
  if (missing.length === 0) {
    return [];
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const separator = source && !source.endsWith('\n') ? newline : '';
  appendFileSync(path, `${separator}${missing.join(newline)}${newline}`);
  return missing;
}
