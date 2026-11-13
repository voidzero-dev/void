import { join } from 'node:path';
import { definePagesPluginTests } from '../../../../test/pages-plugin-contract.ts';
import { pagesPlugin } from '../../src/plugin-pages.ts';

definePagesPluginTests(pagesPlugin, join(import.meta.dirname, '__tmp_pages_plugin__'));
