import { defineHandler } from 'void';
import type { InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler((c) => {
  const env = c.env;
  const bindings: Array<{ name: string; type: string }> = [];

  for (const [name, value] of Object.entries(env).filter(([n]) => !n.startsWith('__'))) {
    let type: string = typeof value;
    if (value === null || value === undefined) {
      type = 'null';
    } else if (typeof value === 'object') {
      // Try to identify CF binding types
      const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
      type = proto?.constructor?.name || 'object';
    }
    bindings.push({ name, type });
  }

  bindings.sort((a, b) => a.name.localeCompare(b.name));

  return { bindings };
});
