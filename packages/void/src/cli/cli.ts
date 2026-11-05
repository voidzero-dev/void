#!/usr/bin/env node

// The bin entry. It imports only the dependency-free runtime check, so an
// unsupported Node or Bun gets a clear message instead of a link-time
// SyntaxError from a newer API somewhere in the CLI's module graph.
import { unsupportedRuntimeMessage } from './runtime-support.ts';

const message = unsupportedRuntimeMessage(process.versions, process.execPath);
if (message) {
  process.stderr.write(`${message}\n`);
  // exitCode instead of exit() so the message is flushed when stderr is a pipe.
  process.exitCode = 1;
} else {
  await import('./cli-main.ts');
}
