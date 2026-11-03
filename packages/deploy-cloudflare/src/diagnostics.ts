import { stripVTControlCharacters } from 'node:util';
import type { CloudflareCommandResult } from './execute.ts';

const MAX_DIAGNOSTIC_LENGTH = 4096;
const MAX_DIAGNOSTIC_LINES = 24;
const ERROR_BOX =
  /(?:^|\n)[ \t]*┌[ \t]*(?:APIError|Error)\b[^\n]*\n(?:[ \t]*│[^\n]*\n)*[ \t]*└[^\n]*/i;
// cf draws upload progress, binding tables, config diffs and upload conflicts as log
// lines: a guide symbol, or its fallback for terminals without Unicode, then two spaces.
// These lines can show binding values. cf printed them on stdout before 1.0.0-beta.21,
// and on stderr since.
const LOG_LINE = /^[├│◆◇●▲■└|*o•!x—](?: {2}|$)/;
const UPLOAD_CONFLICT =
  /^[ \t]*(?:\S[ \t]+)?(Aborting the upload operation because of conflicts\..*)$/m;
const SCRIPT_API_ORIGIN =
  /^[ \t]*(?:\S[ \t]+)?(You are about to upload a Worker that was last updated via the script API\.)/m;

function withoutLogLines(output: string): string {
  return output
    .split('\n')
    .filter((line) => !LOG_LINE.test(line))
    .join('\n');
}

/** Keep the uploader's error, excluding cf's log lines and redacting common credential formats. */
export function cloudflareCommandDiagnostic(result: CloudflareCommandResult): string | undefined {
  const stderr = stripVTControlCharacters(result.stderr).replace(/\r\n?/g, '\n');
  const stdout = stripVTControlCharacters(result.stdout).replace(/\r\n?/g, '\n');
  let message = result.error || stderr;
  for (const output of [stderr, stdout]) {
    const marker = /(?:^|\n)[ \t]*(?:[✘×X][ \t]+)?\[ERROR\]\s*/i.exec(output);
    if (marker) {
      message = output.slice(marker.index + marker[0].length);
      break;
    }
  }
  if (message === stderr && !/(?:^|\n)[ \t]*(?:[✘×X][ \t]+)?\[ERROR\]/i.test(stderr)) {
    // Copy only an error box on stdout, the upload conflict without the config diff
    // that explains it, or stderr without cf's log lines.
    const box = ERROR_BOX.exec(stdout);
    const conflict = UPLOAD_CONFLICT.exec(`${stdout}\n${stderr}`);
    if (box) {
      message = box[0].trim();
    } else if (conflict) {
      message = [SCRIPT_API_ORIGIN.exec(`${stdout}\n${stderr}`)?.[1], conflict[1]]
        .filter(Boolean)
        .join('\n');
    } else {
      // Keep an error box on stderr whole: its bars look like log lines.
      const stderrBox = ERROR_BOX.exec(stderr);
      message = stderrBox
        ? withoutLogLines(stderr.slice(0, stderrBox.index)) +
          stderrBox[0] +
          withoutLogLines(stderr.slice(stderrBox.index + stderrBox[0].length))
        : withoutLogLines(stderr);
    }
  }
  // Never echo stdout, or cf's log lines on stderr, when no error block was found,
  // even when the process failed without stderr.
  message = stripVTControlCharacters(message)
    .split(/\n\s*(?:🪵|Logs (?:were )?written|If you think this is a bug)/)[0]!
    .trim();
  if (!message) {
    return undefined;
  }

  message = message
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(
      /([?&](?:X-Amz-[A-Za-z0-9-]+|signature|sig|token|access_token|key)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[redacted]@')
    .replace(
      /(\b(?:CLOUDFLARE_API_TOKEN|CF_ACCESS_CLIENT_SECRET|access_token|refresh_token|api[_-]?(?:key|token)|password|secret)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    );
  const bounded = message
    .split('\n')
    .slice(0, MAX_DIAGNOSTIC_LINES)
    .join('\n')
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
  return bounded.length < message.length ? `${bounded}\n[diagnostic truncated]` : bounded;
}
