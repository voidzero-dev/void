import type { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import {
  isCI,
  log,
  note as promptsNote,
  outro,
  settings,
  spinner,
  type SpinnerOptions,
  type SpinnerResult,
} from '@voidzero-dev/vite-plus-prompts';
import pc from 'picocolors';
import terminalLink from 'terminal-link';

export { pc };

/** Keep the destination visible when the terminal cannot render a named hyperlink. */
export function formatLink(text: string, url: string): string {
  return terminalLink(text, sanitizeTerminalText(url), {
    fallback: (label, href) => (label === href ? label : `${label}: ${href}`),
  });
}

/** Link a displayed URL without duplicating it in unsupported terminals or redirected output. */
export function formatUrl(url: string): string {
  const text = sanitizeTerminalText(url);
  return formatLink(text, text);
}

/** Complete an action with the same spacing, checkmark, and color on every target. */
export function printSuccess(message: string): void {
  // Remove nested styles so a blue URL or dim hint cannot override the success color.
  outro(`\n${pc.green(`✓ ${stripVTControlCharacters(message)}`)}`, { withGuide: false });
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Keep recovery commands on the same CLI when using the local checkout launcher. */
export function cliCommandName(): 'void' | 'void-dev' {
  const entryName = process.argv[1]?.split(/[\\/]/).at(-1);
  return entryName === 'void-dev' || entryName === 'void-dev.cmd' ? 'void-dev' : 'void';
}

/** Keep phase updates visible in static progress output, including redirected terminals. */
export function createSpinner(
  options?: Pick<SpinnerOptions, 'onCancel'>,
  isTerminal: boolean = process.stdout.isTTY === true,
): SpinnerResult {
  const accessible =
    settings?.accessible ?? ![undefined, '', '0', 'false'].includes(process.env.ACCESSIBLE);
  if (!isCI() && isTerminal && !accessible) {
    return spinner(options);
  }

  let currentMessage = '';
  let cancelled = false;
  return {
    start(msg = '') {
      currentMessage = msg;
      cancelled = false;
      if (msg) {
        log.step(msg);
      }
    },
    stop(msg = '') {
      if (msg) {
        log.info(msg);
      }
    },
    message(msg = '') {
      if (msg && msg !== currentMessage) {
        currentMessage = msg;
        log.step(msg);
      }
    },
    cancel(msg = '') {
      cancelled = true;
      if (msg) {
        log.warn(msg);
      }
    },
    error(msg = '') {
      if (msg) {
        log.error(msg);
      }
    },
    pause() {},
    resume(msg = '') {
      this.message(msg);
    },
    clear() {},
    get isCancelled() {
      return cancelled;
    },
  };
}

/** Narrowest terminal the shared box renderer can draw a note in, guide bar included. */
const MIN_NOTE_COLUMNS = 6;

/**
 * The shared box renderer throws when the terminal is narrower than its smallest box (a 0x0 pty
 * reports 0 columns). Treat a non-positive width as unknown, like `stdout.columns || 80` elsewhere
 * in the CLI, and draw tiny terminals at the narrowest width the box supports.
 */
export function note(...args: Parameters<typeof promptsNote>): void {
  const [message, title, opts] = args;
  const plainTitle = title && sanitizeTerminalText(stripVTControlCharacters(title));
  const urlTitle = plainTitle && /^https?:\/\/\S+$/.test(plainTitle) ? plainTitle : undefined;
  // Native macOS Terminal recognizes URLs by whitespace boundaries.
  const boxedTitle = urlTitle ? ` ${urlTitle} ` : title;
  const output = opts?.output ?? process.stdout;
  const columns = (output as { columns?: unknown }).columns;
  const needsWidthFallback = typeof columns === 'number' && columns < MIN_NOTE_COLUMNS;
  if (!urlTitle && !needsWidthFallback) {
    promptsNote(...args);
    return;
  }
  // The box renderer only reads `columns` and calls `write()`.
  let header = true;
  const sized = {
    columns: needsWidthFallback ? (columns > 0 ? MIN_NOTE_COLUMNS : 80) : columns,
    write(chunk: string) {
      // Insert the link after layout: the renderer counts OSC 8 destinations
      // toward the title width and can otherwise truncate a URL that fits.
      if (header && urlTitle) {
        const label = chunk.includes(urlTitle)
          ? urlTitle
          : stripVTControlCharacters(chunk).match(/ (\S*…)/)?.[1];
        if (label) {
          chunk = chunk.replace(label, () => terminalLink(label, urlTitle, { fallback: false }));
        }
      }
      header = false;
      return output.write(chunk);
    },
  } as unknown as Writable;
  promptsNote(message, boxedTitle, { ...opts, output: sized });
}

export function sectionTitle(title: string): string {
  return pc.reset(pc.blue(title));
}

export function categoryTitle(title: string): string {
  return pc.reset(pc.bold(title));
}

export function dim(text: string): string {
  return pc.dim(text);
}

export function tablePrefix(): string {
  return `${pc.gray('│')}  `;
}

/** Strip terminal control characters from text received from a platform. */
export function sanitizeTerminalText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function helpLine(command: string, description: string): string {
  return `${pc.reset(command.padEnd(34))} ${pc.dim(description)}`;
}

/**
 * Ensure a timestamp string will be parsed as UTC by `new Date()`.
 * DB timestamps lack timezone info — appends 'Z' only when no
 * existing indicator (Z, z, or numeric offset) is present.
 */
function ensureUtc(s: string): string {
  const last = s.at(-1);
  if (last === 'Z' || last === 'z') {
    return s;
  }
  if (s.includes('+', 10)) {
    return s;
  }
  if (s.lastIndexOf('-') > 9) {
    return s;
  }
  return s + 'Z';
}

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(ensureUtc(iso)).getTime();
  if (diffMs < 60_000) {
    return 'just now';
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stack frames of an error a Worker reported, one line per frame. The log or
 * exception line already shows `Name: message`, so a leading copy of that
 * header is dropped; Workers send stacks both with and without it.
 */
export function errorStackFrames(error: unknown): Array<string> {
  if (!error || typeof error !== 'object') {
    return [];
  }
  const { name, message, stack } = error as { name?: unknown; message?: unknown; stack?: unknown };
  if (typeof stack !== 'string') {
    return [];
  }
  const header = message ? `${String(name)}: ${String(message)}` : String(name);
  const frames =
    stack === header
      ? ''
      : stack.startsWith(`${header}\n`)
        ? stack.slice(header.length + 1)
        : stack;
  return frames.trimEnd() ? frames.trimEnd().split('\n') : [];
}
