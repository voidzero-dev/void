import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { BuildLogs } from '../../src/admin/react/views/BuildLogs.tsx';
import type { Build } from '../../src/types.ts';

const { effects, states, fate } = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | void>,
  states: [] as Array<{ value: unknown }>,
  fate: { request: vi.fn(), readView: vi.fn() },
}));

// Drive the component's actual effect and timers without mounting a browser.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => (() => void) | void) => effects.push(effect),
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => {
    const state = { value: initial };
    states.push(state);
    return [
      initial,
      (update: unknown) => {
        // oxlint-disable-next-line typescript/no-unsafe-call -- Run the updater passed to the test implementation of useState.
        state.value = typeof update === 'function' ? update(state.value) : update;
      },
    ];
  },
}));
vi.mock('react-fate', () => ({ useFateClient: () => fate }));
vi.mock('../../src/admin/fate/views.ts', () => ({
  BuildLogsView: {},
  buildLogsRequest: (id: string, since: number) => ({ id, since }),
}));

let cleanup: (() => void) | void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  effects.length = 0;
  states.length = 0;
  fate.request.mockReset().mockResolvedValue({ buildLogs: {} });
  fate.readView.mockReset();
});
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
});

async function mount() {
  BuildLogs({ build: { id: 'build', status: 'complete' } as Build });
  cleanup = effects[0]();
  await vi.advanceTimersByTimeAsync(0);
}

it('follows an initially terminal build until its delayed final tail is captured', async () => {
  fate.readView
    .mockResolvedValueOnce({ data: { lines: [], lastSeq: 2, terminal: true, logsComplete: false } })
    .mockResolvedValueOnce({
      data: {
        lines: [{ seq: 3, line: 'final tail', stream: 'stdout' }],
        lastSeq: 3,
        terminal: true,
        logsComplete: true,
      },
    });

  await mount();
  await vi.advanceTimersByTimeAsync(2000);

  expect(fate.request.mock.calls.map(([request]) => request.since)).toEqual([0, 2]);
  expect(states[0]?.value).toEqual([{ seq: 3, line: 'final tail', stream: 'stdout' }]);
  expect(states[1]?.value).toBeNull();
  await vi.advanceTimersByTimeAsync(6000);
  expect(fate.request).toHaveBeenCalledTimes(2);
});

it('retains historical rows and stops with an upgrade message when completion is unknown', async () => {
  fate.readView.mockResolvedValue({
    data: {
      lines: [{ seq: 3, line: 'historical tail', stream: 'stdout' }],
      lastSeq: 3,
      terminal: true,
      logsComplete: null,
    },
  });

  await mount();
  await vi.advanceTimersByTimeAsync(6000);

  expect(states[0]?.value).toEqual([{ seq: 3, line: 'historical tail', stream: 'stdout' }]);
  expect(states[1]?.value).toContain('Upgrade the platform runtime');
  expect(fate.request).toHaveBeenCalledTimes(1);
});

it('stops incomplete terminal log polling after two minutes', async () => {
  fate.readView.mockResolvedValue({
    data: {
      lines: [],
      lastSeq: 0,
      terminal: true,
      logsComplete: false,
    },
  });

  await mount();
  await vi.advanceTimersByTimeAsync(120_000);
  const calls = fate.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);

  expect(calls).toBe(61);
  expect(fate.request).toHaveBeenCalledTimes(calls);
  expect(states[1]?.value).toContain('Reload to recover the final log tail');
});
