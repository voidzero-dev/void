import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite-plus';

// Run typegen after `vp build` supplies .void/tsconfig.json. Loading Void again here would
// overwrite the built Worker entry with the dev one and prevent cache replay.
export default defineConfig({
  plugins: [reactRouter()],
});
