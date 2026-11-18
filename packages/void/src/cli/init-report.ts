import { log } from '@voidzero-dev/vite-plus-prompts';
import { printDone, printNextStep } from './output.ts';

/** A file that one `void init` run created or changed. */
export type InitFileChange = {
  kind: 'created' | 'updated';
  path: string;
  /** What changed in an updated file. A created file lists none. */
  details: Array<string>;
};

/**
 * What one `void init` run did. Init records its work here instead of logging
 * each step, then prints a short summary when it finishes.
 */
export class InitReport {
  readonly files: Array<InitFileChange> = [];
  /** Finished work other than file changes. */
  readonly completed: Array<string> = [];
  /** What the user should do next. */
  readonly nextSteps: Array<string> = [];
  /**
   * A new starter in one line, such as "Created a React Pages starter with D1
   * (SQLite)". The summary shows it alone, since listing the starter's files
   * would add little.
   */
  starter: string | undefined;
  private printed = false;

  /** Record a new file. Later changes to it in the same run keep it a new file. */
  created(path: string): void {
    const file = this.files.find((entry) => entry.path === path);
    if (file) {
      file.kind = 'created';
      file.details = [];
      return;
    }
    this.files.push({ kind: 'created', path, details: [] });
  }

  /** Record a change to an existing file. A file lists each detail once. */
  updated(path: string, detail: string): void {
    const file = this.files.find((entry) => entry.path === path);
    if (!file) {
      this.files.push({ kind: 'updated', path, details: [detail] });
    } else if (file.kind === 'updated' && !file.details.includes(detail)) {
      file.details.push(detail);
    }
  }

  /** Record a write to `path`, which `existed` before it. */
  wrote(path: string, existed: boolean, detail: string): void {
    if (existed) {
      this.updated(path, detail);
    } else {
      this.created(path);
    }
  }

  done(message: string): void {
    this.completed.push(message);
  }

  next(message: string): void {
    this.nextSteps.push(message);
  }

  /** One line per file: created files first, then updated files with their details aligned. */
  fileLines(): Array<string> {
    const created = this.files.filter((file) => file.kind === 'created');
    const updated = this.files.filter((file) => file.kind === 'updated');
    const width = Math.max(0, ...updated.map((file) => file.path.length));
    return [
      ...created.map((file) => `+ ${file.path}`),
      ...updated.map((file) => `~ ${file.path.padEnd(width)}  ${file.details.join(', ')}`),
    ];
  }

  /**
   * Print the summary of a finished run: the new starter, or else the changed
   * files. A `targeted` run (`--tsconfig`, `--github`) checks only part of the
   * setup, so finding nothing to change there does not show that Void is set up.
   */
  print(targeted = false): void {
    this.printed = true;
    if (this.starter) {
      printDone(this.starter);
    } else {
      const lines = this.fileLines();
      if (lines.length > 0) {
        printDone(['Configured Void', ...lines]);
      } else {
        printDone(targeted ? 'No files changed.' : 'Void is already set up. No files changed.');
      }
    }
    this.printOtherWork();
  }

  /**
   * Run init's `steps`. If they stop early, print what they had recorded, so
   * that the run does not leave changes it never mentioned. A failed step
   * throws; a cancelled prompt exits the process, also from the modules that
   * init calls, so only an exit listener sees every one.
   */
  async printIfStopped(steps: () => Promise<void>): Promise<void> {
    const onExit = (): void => this.printStopped();
    process.once('exit', onExit);
    try {
      await steps();
    } catch (error) {
      this.printStopped();
      throw error;
    } finally {
      process.removeListener('exit', onExit);
    }
  }

  /** Print what the run did before it stopped. Prints nothing if it did nothing. */
  private printStopped(): void {
    if (this.printed) {
      return;
    }
    this.printed = true;
    const lines = this.starter ? [] : this.fileLines();
    if (lines.length > 0) {
      log.warn(['Setup did not finish. Files changed so far:', ...lines].join('\n'));
    } else if (this.starter || this.completed.length > 0 || this.nextSteps.length > 0) {
      log.warn('Setup did not finish. Done so far:');
    } else {
      return;
    }
    if (this.starter) {
      printDone(this.starter);
    }
    this.printOtherWork();
  }

  private printOtherWork(): void {
    for (const message of this.completed) {
      printDone(message);
    }
    for (const message of this.nextSteps) {
      printNextStep(message);
    }
  }
}
