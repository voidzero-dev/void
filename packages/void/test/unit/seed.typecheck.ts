import { integer, sqliteTable, text as sqliteText } from '../../src/runtime/db/schema/d1.ts';
import { int, mysqlTable, text as mysqlText } from '../../src/runtime/db/schema/mysql.ts';
import {
  pgTable,
  serial,
  text as pgText,
  timestamp,
} from '../../src/runtime/db/schema/postgres.ts';
import { defineSeed } from '../../src/runtime/db/seed.ts';

const sqliteSchema = {
  messages: sqliteTable('messages', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    text: sqliteText('text').notNull(),
  }),
};

const postgresSchema = {
  messages: pgTable('messages', {
    id: serial('id').primaryKey(),
    text: pgText('text').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  }),
};

const mysqlSchema = {
  messages: mysqlTable('messages', {
    id: int('id').autoincrement().primaryKey(),
    text: mysqlText('text').notNull(),
  }),
};

type PostgresSchema = typeof postgresSchema;
type SqliteSchema = typeof sqliteSchema;
type MySqlSchema = typeof mysqlSchema;

defineSeed<SqliteSchema>(async ({ db, schema }) => {
  await db.insert(schema.messages).values([{ text: 'hello from sqlite' }]);
});

defineSeed<PostgresSchema>(async ({ db, schema }) => {
  await db.insert(schema.messages).values([{ text: 'hello from postgresql' }]);
});

defineSeed<MySqlSchema>(async ({ db, schema }) => {
  await db.insert(schema.messages).values([{ text: 'hello from mysql' }]);
});
