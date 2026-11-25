import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { defineIslandsPluginTests } from '../../../../test/islands-plugin-contract.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

defineIslandsPluginTests(
  islandsPlugin,
  packageFixturePath(import.meta.dirname, '__tmp_islands_plugin__'),
  'data-island',
);
