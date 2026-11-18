import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { createSpinner } from '../../src/cli/output.ts';

const mocks = vi.hoisted(() => ({
  ci: vi.fn(),
  settings: { accessible: undefined as boolean | undefined },
  spinner: vi.fn(),
  log: { step: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  isCI: mocks.ci,
  settings: mocks.settings,
  spinner: mocks.spinner,
  log: mocks.log,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.accessible = undefined;
  vi.stubEnv('ACCESSIBLE', '');
});

afterEach(() => vi.unstubAllEnvs());

it('passes interactive cancellation through to the native spinner', () => {
  mocks.ci.mockReturnValue(false);
  const native = { start: vi.fn() };
  mocks.spinner.mockReturnValue(native);
  const onCancel = vi.fn();
  expect(createSpinner({ onCancel }, true)).toBe(native);
  expect(mocks.spinner).toHaveBeenCalledWith({ onCancel });
});

it('passes the elapsed-time indicator through to the native spinner', () => {
  mocks.ci.mockReturnValue(false);
  mocks.spinner.mockReturnValue({ start: vi.fn() });
  const options = { indicator: 'timer', cancelMessage: 'Installing dependencies' } as const;
  createSpinner(options, true);
  expect(mocks.spinner).toHaveBeenCalledWith(options);
});

it('keeps a cleared or failed step visible without a terminal', () => {
  mocks.ci.mockReturnValue(false);
  const progress = createSpinner({ indicator: 'timer' }, false);
  progress.start('Installing dependencies');
  progress.clear();
  progress.error('Failed to install dependencies');
  expect(mocks.spinner).not.toHaveBeenCalled();
  expect(mocks.log.step.mock.calls).toEqual([['Installing dependencies']]);
  expect(mocks.log.error.mock.calls).toEqual([['Failed to install dependencies']]);
});

it('uses plain progress messages in CI without starting an animated spinner', () => {
  mocks.ci.mockReturnValue(true);
  const progress = createSpinner(undefined, true);
  progress.start('Installing the platform');
  progress.message('Preparing the platform database');
  progress.stop('Platform installed.');
  expect(mocks.spinner).not.toHaveBeenCalled();
  expect(mocks.log.step.mock.calls).toEqual([
    ['Installing the platform'],
    ['Preparing the platform database'],
  ]);
  expect(mocks.log.info).toHaveBeenCalledWith('Platform installed.');
});

it('uses plain progress messages when output is redirected', () => {
  mocks.ci.mockReturnValue(false);
  createSpinner(undefined, false).start('Uploading the Worker...');
  expect(mocks.spinner).not.toHaveBeenCalled();
  expect(mocks.log.step).toHaveBeenCalledWith('Uploading the Worker...');
});

it('keeps accessible progress static and retains distinct phase updates', () => {
  mocks.ci.mockReturnValue(false);
  vi.stubEnv('ACCESSIBLE', '1');
  const progress = createSpinner(undefined, true);
  progress.start('Uploading');
  progress.pause();
  progress.resume('Uploading');
  progress.message('Publishing');
  progress.cancel('Cancelled');
  expect(mocks.spinner).not.toHaveBeenCalled();
  expect(mocks.log.step.mock.calls).toEqual([['Uploading'], ['Publishing']]);
  expect(progress.isCancelled).toBe(true);
  progress.start('Retrying');
  expect(progress.isCancelled).toBe(false);
});

it('honors explicit shared accessibility settings over the environment', () => {
  mocks.ci.mockReturnValue(false);
  mocks.settings.accessible = false;
  vi.stubEnv('ACCESSIBLE', '1');
  createSpinner(undefined, true);
  expect(mocks.spinner).toHaveBeenCalled();
});
