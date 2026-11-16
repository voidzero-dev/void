import { env } from 'void/env';

export const loader = () => Response.json({ SCHEMA_DEFAULT: env.SCHEMA_DEFAULT });
