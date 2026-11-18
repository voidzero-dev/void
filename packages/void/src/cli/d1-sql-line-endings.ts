/**
 * Turn structural CRLF line endings into LF before SQL goes to the D1 query API. That API fails
 * on CRLF inside a compound statement such as a `CREATE TRIGGER ... BEGIN ... END;` body
 * (`incomplete input: SQLITE_ERROR [7500]`), while the import API accepts the same bytes. Line
 * endings inside quoted values and identifiers ('...', "...", `...`, [...]) are kept, so stored
 * data does not change. Comments are skipped so a quote inside one does not start a string.
 * Matches wrangler's `normalizeSqlLineEndings` (cloudflare/workers-sdk#15044), except that a
 * bracket identifier ends at the first `]`, as in SQLite's tokenizer.
 */
export function normalizeD1SqlLineEndings(sql: string): string {
  if (!sql.includes('\r\n')) {
    return sql;
  }
  let out = '';
  let index = 0;
  const crlfAt = (at: number) => sql[at] === '\r' && sql[at + 1] === '\n';
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      // Copy the quoted text as is. A doubled quote is an escape, except in [brackets].
      const close = char === '[' ? ']' : char;
      let end = index + 1;
      for (;;) {
        const found = sql.indexOf(close, end);
        if (found === -1) {
          end = sql.length;
          break;
        }
        end = found + 1;
        if (close === ']' || sql[end] !== close) {
          break;
        }
        end++;
      }
      out += sql.slice(index, end);
      index = end;
    } else if (char === '-' && next === '-') {
      // A line comment runs to the end of the line; its line ending is structural.
      let end = index + 2;
      while (end < sql.length && sql[end] !== '\n' && !crlfAt(end)) {
        end++;
      }
      out += sql.slice(index, end);
      index = end;
    } else if (char === '/' && next === '*') {
      const found = sql.indexOf('*/', index + 2);
      const end = found === -1 ? sql.length : found + 2;
      out += sql.slice(index, end).replaceAll('\r\n', '\n');
      index = end;
    } else if (crlfAt(index)) {
      out += '\n';
      index += 2;
    } else {
      out += char;
      index++;
    }
  }
  return out;
}
