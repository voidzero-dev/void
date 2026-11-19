import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite-plus';

// For `react-router typegen` in the build script. Generating route types does not need Void.
// With Void loaded, it would write the dev Worker entry that the build then replaces, and the
// two steps would never be replayed from the task cache.
export default defineConfig({
  plugins: [reactRouter()],
});
