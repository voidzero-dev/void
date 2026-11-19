import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const cache = new URL('.font-memory/', root);
const upstream =
  'https://raw.githubusercontent.com/google/fonts/5bd87dfc525c8a0d1d8529d3684716e00c3fc59a/ofl/roboto/';
await mkdir(cache, { recursive: true });
for (const [local, remote] of [
  ['Roboto.ttf', 'Roboto%5Bwdth,wght%5D.ttf'],
  ['Roboto-OFL.txt', 'OFL.txt'],
]) {
  const path = new URL(local, cache);
  try {
    await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    console.log(`Downloading ${local} for the memory demo (cached locally).`);
    const response = await fetch(upstream + remote);
    if (!response.ok) {
      throw new Error(`Font download failed: HTTP ${response.status}`);
    }
    await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  }
}

process.env.VOID_IMAGE_MEMORY_DEMO = '1';
process.env.VOID_IMAGE_MEMORY_FONT_PATH = fileURLToPath(new URL('Roboto.ttf', cache));
const { createServer } = await import('vite');
const server = await createServer({
  root: fileURLToPath(root),
  server: { host: '127.0.0.1', port: 5176, strictPort: true },
});
await server.listen();
console.log(`Font memory reproduction: http://127.0.0.1:5176/font-memory (PID ${process.pid})`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
