import { defineEnv, number } from 'void/env';

// Only the schema supplies this default, so a Worker that ignores env.ts reads undefined.
export default defineEnv({
  SCHEMA_DEFAULT: number().default(48213),
});
