import { basename, dirname } from 'node:path/posix';

// A directory with more files than this is divided by file name.
const directoryLimit = 20;
// A name prefix shared by at least this many files gets a chunk of its own.
const prefixMinimum = 8;

/**
 * Divides test files into the chunks that `vp run test` caches separately. A chunk is rerun when
 * a file that one of its tests reads changes, so files that cover the same code belong together.
 * A directory is one chunk. A large directory is divided by the first word of the file name
 * (`deploy-*.test.ts`), and its remaining files by their first letter.
 */
export function chunkTestFiles(files: ReadonlyArray<string>): Map<string, Array<string>> {
  const directories = new Map<string, Array<string>>();
  for (const file of [...files].sort()) {
    const directory = dirname(file);
    directories.set(directory, [...(directories.get(directory) ?? []), file]);
  }

  const chunks = new Map<string, Array<string>>();
  for (const [directory, directoryFiles] of directories) {
    if (directoryFiles.length <= directoryLimit) {
      chunks.set(directory, directoryFiles);
      continue;
    }
    const prefix = (file: string) => basename(file).split(/[-.]/)[0];
    const prefixCounts = new Map<string, number>();
    for (const file of directoryFiles) {
      prefixCounts.set(prefix(file), (prefixCounts.get(prefix(file)) ?? 0) + 1);
    }
    for (const file of directoryFiles) {
      const name =
        (prefixCounts.get(prefix(file)) ?? 0) >= prefixMinimum
          ? `${directory}/${prefix(file)}-`
          : `${directory}/${basename(file)[0]}`;
      chunks.set(name, [...(chunks.get(name) ?? []), file]);
    }
  }
  return chunks;
}
