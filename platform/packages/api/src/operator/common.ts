import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiEnv } from '../env.ts';

export class OperatorError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code = 'operator_error',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OperatorError';
    this.status = status as ContentfulStatusCode;
    this.code = code;
    this.details = details;
  }
}

export async function readBody(context: Context<ApiEnv>): Promise<Record<string, unknown>> {
  if (
    context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new OperatorError(415, 'Send an application/json request body.', 'invalid_content_type');
  }
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new OperatorError(400, 'The request body must be valid JSON.', 'invalid_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OperatorError(400, 'The request body must be a JSON object.', 'invalid_json');
  }
  dryRun(body as Record<string, unknown>);
  return body as Record<string, unknown>;
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
  options: { optional?: boolean; maxLength?: number } = {},
): string {
  const value = body[key];
  if (value === undefined && options.optional) {
    return '';
  }
  if (typeof value !== 'string' || !value.trim() || value.length > (options.maxLength ?? 512)) {
    throw new OperatorError(
      400,
      `${key} must be a nonempty string of at most ${options.maxLength ?? 512} characters.`,
      'invalid_argument',
    );
  }
  return value.trim();
}

type Pagination = {
  page: number;
  limit: number;
  offset: number;
};

export function pagination(context: Context<ApiEnv>): Pagination {
  const parse = (name: string, fallback: number, maximum: number): number => {
    const raw = context.req.query(name);
    if (raw === undefined) {
      return fallback;
    }
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) {
      throw new OperatorError(
        400,
        `${name} must be an integer between 1 and ${maximum}.`,
        'invalid_argument',
      );
    }
    return Number(raw);
  };
  const page = parse('page', 1, 1_000_000);
  const limit = parse('limit', 20, 100);
  return { page, limit, offset: (page - 1) * limit };
}

export function dryRun(body: Record<string, unknown>): boolean {
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    throw new OperatorError(400, 'dryRun must be a boolean.', 'invalid_argument');
  }
  return body.dryRun === true;
}

export function preview<
  const Action extends string,
  const Target extends string | Record<string, unknown>,
  const Details extends Record<string, unknown> = Record<string, never>,
>(action: Action, target: Target, details: Details = {} as Details) {
  return { ...details, dryRun: true as const, action, target };
}
