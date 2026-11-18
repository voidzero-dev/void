// What the runner accepts as scan input. The API's input builder
// (`platform/packages/api/src/security/input/build.ts`) imports these numbers, so
// it never builds a tar or a task the runner refuses. No imports: the API bundles
// this file into a Worker.

export const SCAN_INPUT_LIMITS = {
  /** Entries in the input tar (`task.json`, `input/…`, `memory/…`). */
  maxFiles: 20_000,
  /** Bytes of one tar entry. */
  maxFileBytes: 16 * 1024 * 1024,
  /** Bytes of all tar entries. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** Characters of one tar path. */
  maxTarPathChars: 4096,
  /** Characters of one `changed_files` path in `task.json`. */
  maxTaskPathChars: 1024,
} as const;
