import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expectTypeOf } from 'vite-plus/test';
import {
  and,
  asc,
  createDb,
  eq,
  sql,
  type AnyColumn,
  type BatchItem,
  type SQL,
  type SQLWrapper,
} from '../../src/runtime/db.ts';

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
});

declare const binding: D1Database;
const db = createDb(binding);

function contains(column: SQLWrapper, value: string): SQL {
  return sql`instr(${column}, ${value}) > 0`;
}

function countIf(condition: SQL) {
  return sql<number>`sum(case when ${condition} then 1 else 0 end)`;
}

function orderBy(column: AnyColumn) {
  return asc(column);
}

const condition = and(eq(posts.id, 1), contains(posts.title, 'void'));
expectTypeOf(condition).toEqualTypeOf<SQL | undefined>();
countIf(eq(posts.id, 1));
orderBy(posts.title);

const writes: [BatchItem<'sqlite'>, ...Array<BatchItem<'sqlite'>>] = [
  db.update(posts).set({ title: 'Void' }).where(eq(posts.id, 1)),
];
writes.push(db.insert(posts).values({ id: 2, title: 'Void' }));
void db.batch(writes);
