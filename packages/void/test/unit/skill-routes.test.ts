import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';

const packageDir = join(import.meta.dirname, '../..');
const referenceDir = join(packageDir, '../../docs/reference');
const skill = readFileSync(join(packageDir, 'skills/void/SKILL.md'), 'utf8');

it('routes every reference page from the void skill', () => {
  const pages = readdirSync(referenceDir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/reference/${file.replaceAll('\\', '/')}`);

  expect(pages.filter((page) => !skill.includes(page))).toEqual([]);
});
