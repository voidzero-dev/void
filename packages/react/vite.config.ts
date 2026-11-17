import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: 'vp pack',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
  pack: {
    entry: [
      'src/index.ts',
      'src/plugin.ts',
      'src/runtime/pages-client.ts',
      'src/runtime/pages-server.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      resolveDepSubpath: true,
      neverBundle: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/server',
        'react-dom/client',
        'vite',
        'void',
        'void/*',
        '@vitejs/plugin-react',
      ],
    },
  },
});
