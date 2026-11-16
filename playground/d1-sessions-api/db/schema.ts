import { blob, integer, sqliteTable, text } from 'void/schema-d1';

export const profiles = sqliteTable('bookmark_profiles', {
  id: text('id').primaryKey(),
  revision: text('revision').notNull(),
  savedAt: text('saved_at').notNull(),
});

export const pressureChunks = sqliteTable('bookmark_pressure_chunks', {
  id: integer('id').primaryKey(),
  payload: blob('payload', { mode: 'buffer' }).notNull(),
});
