import { expectTypeOf } from 'vite-plus/test';
import { createDb, type DrizzleD1Database } from '../../src/runtime/db.ts';

declare const binding: D1Database;

expectTypeOf(createDb(binding, { session: 'first-primary' })).toEqualTypeOf<DrizzleD1Database>();
createDb(binding, { session: 'first-unconstrained' });
createDb(binding);

declare const bookmark: D1SessionBookmark;
binding.withSession(bookmark);
// #783 red reproduction: Void should accept a carried bookmark just as D1 does.
// https://developers.cloudflare.com/d1/best-practices/read-replication/#start-a-session-from-previous-context-bookmark
createDb(binding, { session: bookmark });

// @ts-expect-error Session constraints use D1's supported values.
createDb(binding, { session: 'primary' });
// @ts-expect-error Session options do not accept arbitrary settings.
createDb(binding, { primary: true });
