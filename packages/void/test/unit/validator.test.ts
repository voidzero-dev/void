import { describe, expect, it } from 'vite-plus/test';
import type { CloudContext } from '../../src/runtime/handler.ts';
import { runValidation, type ValidatorSlots } from '../../src/runtime/validator.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

type ValidationIssueBody = {
  error: string;
  issues: Array<{
    slot: string;
    issues: Array<{ message: string; path?: string }>;
  }>;
};

/** Create a mock Standard Schema that always fails with the given issues. */
function failSchema(issues: Array<StandardSchemaV1.Issue>): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate() {
        return { issues };
      },
    },
  };
}

function mockContext(body?: unknown): CloudContext {
  return {
    req: {
      json: async () => body,
      header: () => undefined,
    },
  } as unknown as CloudContext;
}

describe('runValidation', () => {
  it('passes with empty validators', async () => {
    const c = mockContext();
    const result = await runValidation({}, c);
    expect(result.ok).toBe(true);
  });

  it('includes path in flattened issues', async () => {
    const validators: ValidatorSlots = {
      body: failSchema([{ message: 'too short', path: [{ key: 'name' }] }]),
    };
    const c = mockContext({ name: '' });
    const result = await runValidation(validators, c);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const json = (await result.response.json()) as ValidationIssueBody;
      expect(json.issues[0].issues[0].path).toBe('name');
    }
  });
});
