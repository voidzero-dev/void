import { join } from 'node:path';
import { defineIslandsPluginTests } from '../../../../test/islands-plugin-contract.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

defineIslandsPluginTests(
  islandsPlugin,
  join(import.meta.dirname, '__tmp_islands_plugin__'),
  '/@void-island-wrap/',
);
