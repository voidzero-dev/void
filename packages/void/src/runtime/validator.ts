import type { StandardSchemaV1 } from '../standard-schema.ts';
import type { CloudContext } from './handler.ts';

export type ValidatorSlots = {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
};

type ValidationSuccess<V extends ValidatorSlots> = {
  ok: true;
  input: HandlerInput<V>;
};

type ValidationFailure = {
  ok: false;
  response: Response;
};

export type HandlerInput<V extends ValidatorSlots> = {
  [K in keyof V as V[K] extends StandardSchemaV1 ? K : never]: V[K] extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<V[K]>
    : never;
};

function flattenIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): Array<{ message: string; path?: string }> {
  return Array.from(issues, (issue) => ({
    message: issue.message,
    path: issue.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.'),
  }));
}

async function validateSlot(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<
  { ok: true; value: unknown } | { ok: false; issues: ReadonlyArray<StandardSchemaV1.Issue> }
> {
  const result = await schema['~standard'].validate(value);
  if (result.issues) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, value: result.value };
}

type FormEntry = string | File;

const MAX_FORM_DEPTH = 32;
const MAX_FORM_NODES = 10_000;
const MAX_FORM_INDEX = 10_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isFormContentType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'multipart/form-data' || mediaType === 'application/x-www-form-urlencoded';
}

/**
 * `objectToFormData` writes nested fields as `a[b]`, array items as `a[0]`,
 * and file lists as `a[]`. Split one of those keys into path segments.
 * A key that is not entirely bracket-encoded stays a single literal segment.
 */
function formKeySegments(key: string): Array<string> {
  const bracket = key.indexOf('[');
  if (bracket <= 0 || !key.endsWith(']')) {
    return [key];
  }

  const segments = [key.slice(0, bracket)];
  const rest = key.slice(bracket);
  const pattern = /\[([^[\]]*)\]/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rest)) !== null) {
    if (match.index !== consumed) {
      return [key];
    }
    segments.push(match[1] ?? '');
    consumed = pattern.lastIndex;
    if (segments.length > MAX_FORM_DEPTH) {
      throw new Error('Form field is nested too deeply');
    }
  }
  if (consumed !== rest.length) {
    return [key];
  }
  return segments;
}

function arrayIndex(segment: string): number | null {
  if (segment !== '0' && !/^[1-9]\d*$/.test(segment)) {
    return null;
  }
  if (segment.length > 5) {
    throw new Error('Form field index is out of range');
  }
  const index = Number(segment);
  if (index > MAX_FORM_INDEX) {
    throw new Error('Form field index is out of range');
  }
  return index;
}

function isContainerRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Blob)
  );
}

function own(record: Record<string, unknown>, key: string): unknown {
  if (DANGEROUS_KEYS.has(key)) {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
  }
  return record[key];
}

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  if (DANGEROUS_KEYS.has(key)) {
    Object.defineProperty(record, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  record[key] = value;
}

/**
 * Rebuild the object `objectToFormData` flattened. Numeric segments and `[]`
 * become arrays. Scalars are left as the client encoded them.
 */
function formRecordToObject(
  record: Record<string, FormEntry | Array<FormEntry>>,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let nodes = 0;

  const createContainer = (asArray: boolean): Record<string, unknown> | Array<unknown> => {
    if (++nodes > MAX_FORM_NODES) {
      throw new Error('Form field has too many nested values');
    }
    return asArray ? [] : {};
  };

  const read = (parent: Record<string, unknown> | Array<unknown>, segment: string): unknown => {
    if (Array.isArray(parent)) {
      return segment === '' ? undefined : parent[Number(segment)];
    }
    return own(parent, segment);
  };

  const write = (
    parent: Record<string, unknown> | Array<unknown>,
    segment: string,
    value: unknown,
  ): void => {
    if (Array.isArray(parent)) {
      if (segment === '') {
        parent.push(value);
        return;
      }
      const index = arrayIndex(segment);
      if (index === null) {
        throw new Error('Form field shape is inconsistent');
      }
      parent[index] = value;
      return;
    }
    setOwn(parent, segment, value);
  };

  const assign = (segments: Array<string>, value: FormEntry): void => {
    let parent: Record<string, unknown> | Array<unknown> = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i] as string;
      const next = segments[i + 1] as string;
      const nextIsArray = next === '' || arrayIndex(next) !== null;
      const child = read(parent, segment);
      const childIsContainer = nextIsArray ? Array.isArray(child) : isContainerRecord(child);
      const container = childIsContainer
        ? (child as Record<string, unknown> | Array<unknown>)
        : createContainer(nextIsArray);
      if (!childIsContainer) {
        write(parent, segment, container);
      }
      parent = container;
    }
    write(parent, segments[segments.length - 1] as string, value);
  };

  for (const [key, raw] of Object.entries(record)) {
    const segments = formKeySegments(key);
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      assign(segments, value);
    }
  }
  return root;
}

async function readBody(c: CloudContext): Promise<unknown> {
  if (!isFormContentType(c.req.header('content-type'))) {
    return c.req.json();
  }
  // `[]` keys are arrays at runtime even when the declared return type is not.
  const parsed = (await c.req.parseBody()) as Record<string, FormEntry | Array<FormEntry>>;
  return formRecordToObject(parsed);
}

export async function runValidation<V extends ValidatorSlots>(
  validators: V,
  c: CloudContext,
): Promise<ValidationSuccess<V> | ValidationFailure> {
  const input: Record<string, unknown> = {};
  const allIssues: Array<{
    slot: string;
    issues: Array<{ message: string; path?: string }>;
  }> = [];

  if (validators.params) {
    const raw = c.req.param() as Record<string, string>;
    const result = await validateSlot(validators.params, raw);
    if (result.ok) {
      input.params = result.value;
    } else {
      allIssues.push({ slot: 'params', issues: flattenIssues(result.issues) });
    }
  }

  if (validators.query) {
    const raw = Object.fromEntries(
      Object.entries(c.req.queries()).map(([key, values]) => [
        key,
        values.length === 1 ? values[0] : values,
      ]),
    );
    const result = await validateSlot(validators.query, raw);
    if (result.ok) {
      input.query = result.value;
    } else {
      allIssues.push({ slot: 'query', issues: flattenIssues(result.issues) });
    }
  }

  if (validators.body) {
    let raw: unknown;
    const formBody = isFormContentType(c.req.header('content-type'));
    try {
      // Multipart and URL-encoded bodies are what `useForm` sends for files.
      // JSON stays on `c.req.json()` so scalar types there are unchanged.
      raw = await readBody(c);
    } catch {
      return {
        ok: false,
        response: Response.json(
          { error: formBody ? 'Invalid form body' : 'Invalid JSON body' },
          { status: 400 },
        ),
      };
    }
    const result = await validateSlot(validators.body, raw);
    if (result.ok) {
      input.body = result.value;
    } else {
      allIssues.push({ slot: 'body', issues: flattenIssues(result.issues) });
    }
  }

  if (allIssues.length > 0) {
    return {
      ok: false,
      response: Response.json({ error: 'Validation failed', issues: allIssues }, { status: 400 }),
    };
  }

  return { ok: true, input: input as HandlerInput<V> };
}
