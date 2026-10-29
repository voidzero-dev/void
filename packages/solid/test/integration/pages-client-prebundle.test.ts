import { resolve } from 'node:path';
import { registerPagesDependencyTests } from '../../../../test/pages-deps-contract.ts';
import { pagesPlugin } from '../../src/plugin-pages.ts';

registerPagesDependencyTests(resolve(import.meta.dirname, '../..'), (pagesDir) => [
  pagesPlugin(pagesDir),
]);
