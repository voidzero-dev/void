import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { definePagesPluginTests } from '../../../../test/pages-plugin-contract.ts';
import { pagesPlugin } from '../../src/plugin-pages.ts';

definePagesPluginTests(
  pagesPlugin,
  packageFixturePath(import.meta.dirname, '__tmp_pages_plugin__'),
);
