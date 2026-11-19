import { defineHandler } from 'void';
import type { RendererChoice } from '../src/renderer-select.tsx';

export interface Props {
  renderer: RendererChoice;
}

export const loader = defineHandler(
  (c) =>
    ({
      renderer: c.req.query('renderer') === 'browser' ? 'browser' : 'takumi',
    }) satisfies Props,
);
