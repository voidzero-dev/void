import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const script of [
  'build-sandbox-controller.mjs',
  'build-security-scanner-controller.mjs',
  'build-admin-client.mjs',
]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
