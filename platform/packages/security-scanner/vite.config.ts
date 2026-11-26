import { defineConfig } from 'vite-plus';

// Self-contained Node files with no runtime dependencies, one build each so neither
// shares a chunk with the other. `runner.mjs` is embedded in the controller (Engine B,
// managed image) and copied into the Engine A/C images, which also get `void-scan-mcp.mjs`
// (the MCP server Codex starts). The vendor SDKs are installed in those images and loaded
// at run time, never bundled.
const shared = { format: 'esm', platform: 'node', dts: false } as const;

export default defineConfig({
  pack: [
    { ...shared, entry: { runner: 'src/runner/main.ts' }, clean: true },
    { ...shared, entry: { 'void-scan-mcp': 'src/runner/mcp/void-scan.ts' }, clean: false },
  ],
});
