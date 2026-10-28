import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'pathslash';
import { globSync } from 'tinyglobby';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptsDir, '..');
const sourceDir = resolve(packageDir, '../../docs');
const targetDir = resolve(packageDir, 'docs');

if (!existsSync(resolve(sourceDir, 'en'))) {
  throw new Error(`docs: Missing English source directory '${resolve(sourceDir, 'en')}'.`);
}

rmSync(targetDir, { recursive: true, force: true });
rmSync(resolve(packageDir, 'skills/void/docs'), { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

for (const file of globSync('**/*.md', { cwd: sourceDir, ignore: ['node_modules/**', 'README.md'] })) {
  const dest = resolve(targetDir, file.startsWith('en/') ? file.slice(3) : file);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(resolve(sourceDir, file), dest);
}
