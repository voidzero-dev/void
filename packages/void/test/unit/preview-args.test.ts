import { describe, expect, it } from 'vite-plus/test';
import { parsePreviewArgs } from '../../src/cli/preview-args.ts';

describe('parsePreviewArgs', () => {
  it('parses delete with a name', () => {
    expect(parsePreviewArgs(['delete', 'pr-64'])).toEqual({ subcommand: 'delete', name: 'pr-64' });
  });

  it('rejects missing, unknown and extra arguments', () => {
    expect(() => parsePreviewArgs([])).toThrow('void preview delete <name>');
    expect(() => parsePreviewArgs(['list'])).toThrow('void preview delete <name>');
    expect(() => parsePreviewArgs(['delete'])).toThrow('requires a preview name');
    expect(() => parsePreviewArgs(['delete', '--force'])).toThrow('requires a preview name');
    expect(() => parsePreviewArgs(['delete', 'pr-64', 'pr-65'])).toThrow('Unexpected argument');
  });
});
