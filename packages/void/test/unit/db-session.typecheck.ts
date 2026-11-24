import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { expectTypeOf } from 'vite-plus/test';
import { createDb, getBookmark, setSession } from '../../src/runtime/db/index.ts';
import type { DrizzleD1Database } from '../../src/runtime/db/index.ts';

declare const binding: D1Database;

expectTypeOf(createDb(binding, { session: 'first-primary' })).toEqualTypeOf<DrizzleD1Database>();
createDb(binding, { session: 'first-unconstrained' });
createDb(binding);

declare const bookmark: D1SessionBookmark;
binding.withSession(bookmark);
// Void distinguishes carried bookmarks from constraint literals.
// https://developers.cloudflare.com/d1/best-practices/read-replication/#start-a-session-from-previous-context-bookmark
createDb(binding, { session: { bookmark } });
setSession({ bookmark });
setSession('first-primary');
setSession('first-unconstrained');
expectTypeOf(getBookmark()).toEqualTypeOf<D1SessionBookmark | null>();
expectTypeOf(getBookmark(createDb(binding))).toEqualTypeOf<D1SessionBookmark | null>();

const schema = { profile: sqliteTable('profile', { id: integer('id').primaryKey() }) };
declare const schemaClient: DrizzleD1Database<typeof schema>;
expectTypeOf(getBookmark(schemaClient)).toEqualTypeOf<D1SessionBookmark | null>();

// @ts-expect-error Session starts must be constraints or bookmark objects.
createDb(binding, { session: 123 });
// @ts-expect-error Unknown constraint literals are not bookmarks.
setSession('first-primray');
// @ts-expect-error Unknown constraint literals are not bookmarks.
createDb(binding, { session: 'first-primray' });
// @ts-expect-error Bare bookmark strings must be wrapped.
setSession(bookmark);
// @ts-expect-error Bare bookmark strings must be wrapped.
createDb(binding, { session: bookmark });
// @ts-expect-error Missing bookmarks need an explicit fallback.
setSession({ bookmark: undefined });
// @ts-expect-error Null is not a bookmark.
createDb(binding, { session: { bookmark: null } });
// @ts-expect-error Session options do not accept arbitrary settings.
createDb(binding, { primary: true });
