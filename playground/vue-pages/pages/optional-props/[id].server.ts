import { defineHandler } from 'void';

export const loader = defineHandler<{ title: string; note?: string }>((c) =>
  c.req.param('id') === 'second' ? { title: 'Second', note: 'Optional note' } : { title: 'First' },
);
