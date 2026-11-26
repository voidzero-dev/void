import { describe, expect, it } from 'vite-plus/test';
import { readPreviousDeployManifest } from '../../src/deploy/persisted-manifest.ts';

describe('readPreviousDeployManifest', () => {
  it('preserves historical WebSocket migrations and minimal binding metadata', () => {
    const websocket = {
      routes: [{ className: 'Room' }],
      classes: ['Room'],
      migrations: [{ tag: 'ws-v1', newClasses: ['Room'] }],
    };
    const queues = [{ name: 'jobs', bindingName: 'JOBS', maxRetries: null }];
    expect(readPreviousDeployManifest(JSON.stringify({ version: 1, websocket, queues }))).toEqual({
      queues,
      websocket,
    });
  });

  it('rejects invalid migration history instead of treating it as empty', () => {
    const raw = JSON.stringify({ websocket: { routes: [], classes: [], migrations: [null] } });
    expect(() => readPreviousDeployManifest(raw)).toThrow('Invalid persisted deployment history');
  });
});
