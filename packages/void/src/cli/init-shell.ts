import { relative, resolve } from 'pathslash';

/**
 * The directory of the user's shell. Printed commands start there, which is
 * not the project root when init creates a subfolder.
 */
export function shellDirectory(): string {
  return resolve(process.cwd());
}

/** Quote an argument for the user's shell, such as a path with spaces, quotes, $ or backticks. */
export function quoteShellArgument(argument: string): string {
  if (/^[A-Za-z0-9_@./:-]+$/.test(argument)) {
    return argument;
  }
  return process.platform === 'win32'
    ? `"${argument}"`
    : `'${argument.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * The path from the user's shell to `root`, quoted as a command argument, or
 * undefined when the shell is already there.
 */
export function projectPathFromShell(root: string): string | undefined {
  const shell = shellDirectory();
  const directory = resolve(root);
  if (directory === shell) {
    return undefined;
  }
  const path = relative(shell, directory);
  // A command would read a leading dash as an option, and `cd -` as the previous directory.
  return quoteShellArgument(path.startsWith('-') ? `./${path}` : path);
}

/** Prefix `command` with a `cd` from the user's shell into `root` when they differ. */
export function commandInProject(root: string, command: string): string {
  const path = projectPathFromShell(root);
  return path === undefined ? command : `cd ${path} && ${command}`;
}
