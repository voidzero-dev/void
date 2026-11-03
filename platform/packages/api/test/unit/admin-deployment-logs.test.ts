import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vite-plus/test';
import { LogRow } from '../../src/admin/react/views/DeploymentLogs.tsx';

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
