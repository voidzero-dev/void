import * as v from 'valibot';
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({}));

export const action = defineHandler.withValidator({
  body: v.object({ profile: v.object({ name: v.string() }), tags: v.array(v.string()) }),
})(() => {});
