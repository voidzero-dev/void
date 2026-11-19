import { expect, it } from 'vite-plus/test';
import { formatDuration } from '../../src/cli/output.ts';

it.each([
  [0, '1ms'],
  [215, '215ms'],
  [999.6, '1.0s'],
  [2449, '2.4s'],
  [9940, '9.9s'],
  // One decimal would round these up to "10.0s".
  [9960, '10s'],
  [63_400, '63s'],
])('formats %sms as vp create does', (durationMs, expected) => {
  expect(formatDuration(durationMs)).toBe(expected);
});
