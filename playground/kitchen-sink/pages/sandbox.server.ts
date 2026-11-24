import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { defaultSandboxCode, sampleRequests } from '../lib/sandbox-demo.ts';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  return {
    defaultCode: defaultSandboxCode,
    sampleRequests,
  };
});
