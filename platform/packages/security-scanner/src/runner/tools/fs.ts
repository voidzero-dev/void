// Read-only file tools for the model: read_file, list_files, grep. Engine B calls
// them in its loop; Engine C's `void-scan` MCP server wraps the same code.
//
// Rules (spec §15.2 T3, §15.3): only `/scan/input` and `/scan/memory` are readable;
// a path holding `..`, or leading outside `/scan`, is refused; no symlink is ever
// followed (the real path must equal the asked path); only regular files are read;
// big and binary files are refused; every answer is capped in size.

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path/posix';

export type ToolResult = {
  ok: boolean;
  text: string;
  /** A read_file that returned non-blank lines of a file under /scan/input (`stats.reads`). */
  code?: boolean;
};

export type FsToolsOptions = {
  /** The real directory that stands for `/scan`. */
  root: string;
};

const FS_TOOL_LIMITS = {
  maxFileBytes: 4 * 1024 * 1024,
  maxOutputChars: 64_000,
  maxPathChars: 1024,
  defaultReadLines: 400,
  maxReadLines: 2000,
  maxLineChars: 2000,
  maxListEntries: 1000,
  maxListDepth: 8,
  maxPatternChars: 200,
  defaultGrepResults: 100,
  maxGrepResults: 500,
  maxGrepFiles: 5000,
  grepLineChars: 300,
} as const;

const READABLE_AREAS = new Set(['input', 'memory']);
/** How the model sees the scan folder. */
const ROOT = '/scan';

type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;
export type FsTools = Record<'readFile' | 'listFiles' | 'grep', Tool>;

class ToolInputError extends Error {}

async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { ok: false, text: `error: ${error.message}` };
    }
    const code = (error as { code?: unknown }).code;
    if (code === 'ELOOP') {
      return { ok: false, text: 'error: symlinks are not followed' };
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, text: 'error: not found' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, text: 'error: not readable' };
    }
    throw error;
  }
}

/** The read tools by the name the model calls them. */
export function readToolsByName(tools: FsTools): ReadonlyMap<string, Tool> {
  return new Map<string, Tool>([
    ['read_file', (args) => tools.readFile(args)],
    ['list_files', (args) => tools.listFiles(args)],
    ['grep', (args) => tools.grep(args)],
  ]);
}

const displayPath = (segments: ReadonlyArray<string>) => [ROOT, ...segments].join('/');

export function createFsTools(options: FsToolsOptions): FsTools {
  const { maxFileBytes, maxOutputChars } = FS_TOOL_LIMITS;
  let realRootPromise: Promise<string> | undefined;
  const realRoot = () => (realRootPromise ??= realpath(options.root));

  type Resolved = { segments: Array<string>; real: string; display: string };

  async function resolve(value: unknown, fallback: string): Promise<Resolved> {
    const asked = value === undefined || value === null || value === '' ? fallback : value;
    if (typeof asked !== 'string') {
      throw new ToolInputError('path must be a string');
    }
    if (asked.length > FS_TOOL_LIMITS.maxPathChars) {
      throw new ToolInputError('path is too long');
    }
    for (let index = 0; index < asked.length; index++) {
      if (asked.charCodeAt(index) < 0x20) {
        throw new ToolInputError('path holds a control character');
      }
    }
    let relative: string;
    if (asked === ROOT) {
      relative = '';
    } else if (asked.startsWith(`${ROOT}/`)) {
      relative = asked.slice(ROOT.length + 1);
    } else if (asked.startsWith('/')) {
      throw new ToolInputError(`path is outside ${ROOT}`);
    } else {
      relative = `input/${asked}`;
    }
    const segments: Array<string> = [];
    for (const segment of relative.split('/')) {
      if (segment === '' || segment === '.') {
        continue;
      }
      if (segment === '..' || segment.includes('\\')) {
        throw new ToolInputError('path must not hold ".." or backslashes');
      }
      segments.push(segment);
    }
    if (segments.length === 0 || !READABLE_AREAS.has(segments[0])) {
      throw new ToolInputError(`only ${ROOT}/input and ${ROOT}/memory can be read`);
    }
    const base = await realRoot();
    const expected = join(base, ...segments);
    let real: string;
    try {
      real = await realpath(join(options.root, ...segments));
    } catch {
      throw new ToolInputError(`not found: ${displayPath(segments)}`);
    }
    if (real !== expected) {
      throw new ToolInputError(`symlinks are not followed: ${displayPath(segments)}`);
    }
    return { segments, real, display: displayPath(segments) };
  }

  async function readSmallFile(real: string, display: string): Promise<string> {
    // O_NOFOLLOW: a symlink swapped in after the check is refused by the kernel.
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new ToolInputError(`not a regular file: ${display}`);
      }
      if (stat.size > maxFileBytes) {
        throw new ToolInputError(
          `file is too large to read (${stat.size} bytes): ${display}; use grep to find the lines you need`,
        );
      }
      const buffer = await handle.readFile();
      if (buffer.includes(0)) {
        throw new ToolInputError(`binary file: ${display}`);
      }
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  const cap = (text: string, hint: string): string =>
    text.length <= maxOutputChars
      ? text
      : `${text.slice(0, maxOutputChars)}\n[output truncated; ${hint}]`;

  /** Walks regular files and directories under `start`, never through a symlink. */
  async function* walk(
    start: Resolved,
    maxDepth: number,
  ): AsyncGenerator<{ display: string; real: string; kind: 'file' | 'dir' }> {
    const stack: Array<{ real: string; display: string; depth: number }> = [
      { real: start.real, display: start.display, depth: 0 },
    ];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      const entries = await readdir(current.real, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subdirs: typeof stack = [];
      for (const entry of entries) {
        const real = join(current.real, entry.name);
        const display = `${current.display}/${entry.name}`;
        if (entry.isDirectory()) {
          yield { display, real, kind: 'dir' };
          if (current.depth + 1 < maxDepth) {
            subdirs.push({ real, display, depth: current.depth + 1 });
          }
        } else if (entry.isFile()) {
          yield { display, real, kind: 'file' };
        }
        // Symlinks, sockets, fifos and devices are skipped.
      }
      stack.push(...subdirs.reverse());
    }
  }

  return {
    readFile: (args) =>
      guard(async () => {
        const target = await resolve(args.path, '');
        const offset = readCount(args.offset, 1, 1, Number.MAX_SAFE_INTEGER, 'offset');
        const limit = readCount(
          args.limit,
          FS_TOOL_LIMITS.defaultReadLines,
          1,
          FS_TOOL_LIMITS.maxReadLines,
          'limit',
        );
        const text = await readSmallFile(target.real, target.display);
        const lines = text.split('\n');
        if (lines.length > 1 && lines.at(-1) === '') {
          lines.pop();
        }
        if (offset > Math.max(lines.length, 1)) {
          return {
            ok: false,
            text: `error: offset ${offset} is past the end (${lines.length} lines)`,
          };
        }
        const last = Math.min(lines.length, offset + limit - 1);
        const out: Array<string> = [
          `${target.display} (lines ${offset}-${last} of ${lines.length})`,
        ];
        for (let line = offset; line <= last; line++) {
          out.push(`${line}\t${clip(lines[line - 1] ?? '', FS_TOOL_LIMITS.maxLineChars)}`);
        }
        if (last < lines.length) {
          out.push(`[more lines; call read_file with offset=${last + 1}]`);
        }
        const code =
          target.segments[0] === 'input' &&
          lines.slice(offset - 1, last).some((line) => line.trim() !== '');
        return {
          ok: true,
          text: cap(out.join('\n'), 'read fewer lines with offset and limit'),
          ...(code ? { code: true } : {}),
        };
      }),

    listFiles: (args) =>
      guard(async () => {
        const target = await resolve(args.path, `${ROOT}/input`);
        const recursive = args.recursive === true;
        const stat = await lstat(target.real);
        if (!stat.isDirectory()) {
          return { ok: false, text: `error: not a directory: ${target.display}` };
        }
        const out: Array<string> = [];
        let more = false;
        for await (const entry of walk(target, recursive ? FS_TOOL_LIMITS.maxListDepth : 1)) {
          if (out.length >= FS_TOOL_LIMITS.maxListEntries) {
            more = true;
            break;
          }
          out.push(entry.kind === 'dir' ? `${entry.display}/` : entry.display);
        }
        if (out.length === 0) {
          return { ok: true, text: `${target.display}/ is empty` };
        }
        if (more) {
          out.push(`[more than ${FS_TOOL_LIMITS.maxListEntries} entries; list a subdirectory]`);
        }
        return { ok: true, text: cap(out.join('\n'), 'list a subdirectory') };
      }),

    grep: (args) =>
      guard(async () => {
        if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
          throw new ToolInputError('pattern must be a non-empty string');
        }
        if (args.pattern.length > FS_TOOL_LIMITS.maxPatternChars) {
          throw new ToolInputError('pattern is too long');
        }
        const insensitive = args.case_insensitive === true;
        const needle = insensitive ? args.pattern.toLowerCase() : args.pattern;
        const maxResults = readCount(
          args.max_results,
          FS_TOOL_LIMITS.defaultGrepResults,
          1,
          FS_TOOL_LIMITS.maxGrepResults,
          'max_results',
        );
        const target = await resolve(args.path, `${ROOT}/input`);
        const stat = await lstat(target.real);
        const files: Array<{ real: string; display: string }> = [];
        if (stat.isFile()) {
          files.push(target);
        } else if (stat.isDirectory()) {
          for await (const entry of walk(target, Number.MAX_SAFE_INTEGER)) {
            if (entry.kind === 'file') {
              files.push(entry);
              if (files.length >= FS_TOOL_LIMITS.maxGrepFiles) {
                break;
              }
            }
          }
        } else {
          throw new ToolInputError(`not a regular file or directory: ${target.display}`);
        }
        const out: Array<string> = [];
        let skipped = 0;
        search: for (const file of files) {
          let text: string;
          try {
            text = await readSmallFile(file.real, file.display);
          } catch (error) {
            if (error instanceof ToolInputError || (error as { code?: unknown }).code === 'ELOOP') {
              skipped++;
              continue;
            }
            throw error;
          }
          const lines = text.split('\n');
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const haystack = insensitive ? line.toLowerCase() : line;
            if (haystack.includes(needle)) {
              out.push(
                `${file.display}:${index + 1}: ${clip(line.trim(), FS_TOOL_LIMITS.grepLineChars)}`,
              );
              if (out.length >= maxResults) {
                out.push(`[stopped at ${maxResults} matches; narrow the path or pattern]`);
                break search;
              }
            }
          }
        }
        if (out.length === 0) {
          out.push(`no matches for "${args.pattern}" in ${target.display}`);
        }
        if (skipped > 0) {
          out.push(`[${skipped} binary or too-large files skipped]`);
        }
        return { ok: true, text: cap(out.join('\n'), 'narrow the path or pattern') };
      }),
  };
}

function readCount(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new ToolInputError(`${name} must be a whole number of at least ${min}`);
  }
  return Math.min(value, max);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
