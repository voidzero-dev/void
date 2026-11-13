import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { expectTypeOf } from 'vite-plus/test';
import { createDb, getBookmark, setSession, type DrizzleD1Database } from '../../src/runtime/db.ts';

declare const binding: D1Database;

expectTypeOf(createDb(binding, { session: 'first-primary' })).toEqualTypeOf<DrizzleD1Database>();
createDb(binding, { session: 'first-unconstrained' });
createDb(binding);

declare const bookmark: D1SessionBookmark;
binding.withSession(bookmark);
// Void accepts a carried bookmark just as D1 does.
// https://developers.cloudflare.com/d1/best-practices/read-replication/#start-a-session-from-previous-context-bookmark
createDb(binding, { session: bookmark });
setSession(bookmark);
setSession('first-primary');
expectTypeOf(getBookmark()).toEqualTypeOf<D1SessionBookmark | null>();
expectTypeOf(getBookmark(createDb(binding))).toEqualTypeOf<D1SessionBookmark | null>();

const schema = { profile: sqliteTable('profile', { id: integer('id').primaryKey() }) };
declare const schemaClient: DrizzleD1Database<typeof schema>;
expectTypeOf(getBookmark(schemaClient)).toEqualTypeOf<D1SessionBookmark | null>();

// @ts-expect-error Session starts must be strings.
createDb(binding, { session: 123 });
// @ts-expect-error Session options do not accept arbitrary settings.
createDb(binding, { primary: true });
