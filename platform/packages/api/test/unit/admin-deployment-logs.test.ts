import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vite-plus/test';
import { LogRow, takeFreshTailEntries } from '../../src/admin/react/views/DeploymentLogs.tsx';

vi.mock('react-fate', () => ({ useFateClient: () => ({}) }));
vi.mock('../../src/admin/fate/views.ts', () => ({
  DeploymentLogsView: {},
  deploymentLogsRequest: () => ({}),
}));

it('renders a minimal row without a URL or empty exception text', () => {
  const markup = renderToStaticMarkup(
    createElement(LogRow, {
      entry: {
        timestamp: 0,
        outcome: 'exception',
        method: 'GET',
        url: '',
        status: '500',
        logs: [{ level: 'error', message: [] }],
        exceptions: [{ name: 'TypeError', message: '' }],
      },
    }),
  );
  expect(markup).toContain('GET');
  expect(markup).toContain('>error<');
  expect(markup).toContain('<span>TypeError</span>');
  expect(markup).not.toContain('TypeError:');
});

it('keeps the full row layout when messages and URLs are recorded', () => {
  const markup = renderToStaticMarkup(
    createElement(LogRow, {
      entry: {
        timestamp: 0,
        outcome: 'exception',
        method: 'GET',
        url: '/api/users',
        status: '500',
        logs: [{ level: 'error', message: ['boom'] }],
        exceptions: [{ name: 'TypeError', message: 'bad input' }],
      },
    }),
  );
  expect(markup).toContain('/api/users');
  expect(markup).toContain('<span>boom</span>');
  expect(markup).toContain('TypeError: bad input');
});

it('keeps two identical minimal rows from one tail poll and drops them when polled again', () => {
  const row = { timestamp: 1, outcome: 'ok', method: 'GET', url: '', status: '200' };
  const seen = new Map<string, number>();
  expect(takeFreshTailEntries([row, { ...row }], seen)).toHaveLength(2);
  expect(takeFreshTailEntries([row, { ...row }], seen)).toHaveLength(0);
  // A third identical request lands in the next poll.
  expect(takeFreshTailEntries([row, { ...row }, { ...row }], seen)).toHaveLength(1);
  expect(takeFreshTailEntries([{ ...row, status: '500' }], seen)).toHaveLength(1);
});
