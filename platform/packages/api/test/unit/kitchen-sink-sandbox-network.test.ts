import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { promisify } from 'node:util';
import { expect, it } from 'vite-plus/test';
import { internetAccessProbe } from '../../../../scripts/fixtures/kitchen-sink-sandbox/lib/internet-probe.ts';

it('closes a stalled network connection so the denial probe exits without being killed', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Probe server did not bind a port.');
    }
    const args = [...internetAccessProbe.slice(1, -2), `https://127.0.0.1:${address.port}/`, '50'];
    const result = await promisify(execFile)(process.execPath, args, { timeout: 2000 });
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
