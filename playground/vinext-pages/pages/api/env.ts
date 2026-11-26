import { env } from 'void/env';

type ApiResponse = { status(code: number): { json(body: unknown): void } };

export default function handler(_request: unknown, response: ApiResponse) {
  response.status(200).json({ SCHEMA_DEFAULT: env.SCHEMA_DEFAULT });
}
