import { createFileRoute } from '@tanstack/react-router';
import { env } from 'void/env';

export const Route = createFileRoute('/api/env')({
  server: {
    handlers: {
      GET: () => Response.json({ SCHEMA_DEFAULT: env.SCHEMA_DEFAULT }),
    },
  },
});
