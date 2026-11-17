import { relative, resolve } from 'pathslash';

/**
 * The directory of the user's shell. Printed commands start there, which is
 * not the project root when init creates a subfolder.
 */
export function shellDirectory(): string {
  return resolve(process.cwd());
}

/** Quote a path for the user's shell, including names containing quotes, $ or backticks. */
export function quoteShellPath(path: string): string {
  if (/^[A-Za-z0-9_@./:-]+$/.test(path)) {
    return path;
  }
  return process.platform === 'win32' ? `"${path}"` : `'${path.replaceAll("'", "'\\''")}'`;
}

/** Prefix `command` with a `cd` from the user's shell into `root` when they differ. */
export function commandInProject(root: string, command: string): string {
  const shell = shellDirectory();
  const directory = resolve(root);
  if (directory === shell) {
    return command;
  }
  const path = relative(shell, directory);
  // `cd` would read a leading dash as an option, and `cd -` as the previous directory.
  return `cd ${quoteShellPath(path.startsWith('-') ? `./${path}` : path)} && ${command}`;
}
