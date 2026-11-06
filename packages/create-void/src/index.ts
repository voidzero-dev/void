#!/usr/bin/env node

// The bin entry. It imports only the dependency-free runtime check, so an
// unsupported Node or Bun gets a clear message instead of a link-time
// SyntaxError from a newer API in the bundled prompts. `void init` stops on an
// unsupported runtime too, so checking first keeps a failed run from leaving a
// half-created folder that blocks the next attempt.
import { unsupportedRuntimeMessage } from './runtime-support.ts';

const message = unsupportedRuntimeMessage(process.versions, process.execPath, 'create-void');
if (message) {
  process.stderr.write(`${message}\n`);
  // exitCode instead of exit() so the message is flushed when stderr is a pipe.
  process.exitCode = 1;
} else {
  await import('./main.ts');
}
