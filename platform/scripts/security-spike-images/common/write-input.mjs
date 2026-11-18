// Writes the scan input for spikes S2/S3. Runs as root from the controller (`exec` with a
// JSON body on stdin: { files: { "<relative path>": "<text>" } }). Only regular files under
// /scan/input; absolute paths, `..` and existing symlinks are refused. The scanner user
// can read the files but not change them.
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = '/scan/input';
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const { files } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const written = [];
for (const [relative, text] of Object.entries(files)) {
  const parts = relative.split('/');
  if (relative.startsWith('/') || parts.includes('..') || parts.includes('')) {
    throw new Error(`refused path: ${relative}`);
  }
  const target = join(ROOT, relative);
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  let existing;
  try {
    existing = lstatSync(target);
  } catch {
    existing = undefined;
  }
  if (existing && !existing.isFile()) {
    throw new Error(`refused non-regular file: ${relative}`);
  }
  writeFileSync(target, text, { mode: 0o644 });
  chmodSync(target, 0o644);
  written.push(relative);
}
console.log(JSON.stringify({ written }));
