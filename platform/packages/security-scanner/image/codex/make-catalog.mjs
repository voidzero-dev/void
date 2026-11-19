// Build step for the Engine C image: turn Codex's bundled model data into our own
// model_catalog_json with only gpt-6.1-terra / gpt-6.1-sol and no way to run commands
// or edit files: shell off, apply_patch off, direct tool mode, no experimental tools,
// no node REPL, no search tool. Usage: node make-catalog.mjs <bundled.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , source, target] = process.argv;
const bundled = JSON.parse(readFileSync(source, 'utf8'));
const keep = ['gpt-6.1-terra', 'gpt-6.1-sol'];
const models = bundled.models
  .filter((model) => keep.includes(model.slug))
  .map((model) => ({
    ...model,
    shell_type: 'disabled',
    apply_patch_tool_type: null,
    tool_mode: 'direct',
    experimental_supported_tools: [],
    node_repl_disabled: true,
    supports_search_tool: false,
    multi_agent_version: null,
  }));
if (models.length !== keep.length) {
  throw new Error(`bundled catalog is missing one of ${keep.join(', ')}`);
}
writeFileSync(target, JSON.stringify({ models }));
console.log(`wrote ${models.length} models to ${target}`);
