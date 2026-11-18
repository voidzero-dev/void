import { env } from 'void/env';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ SCHEMA_DEFAULT: env.SCHEMA_DEFAULT });
}
