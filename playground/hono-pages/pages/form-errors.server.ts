import * as v from 'valibot';
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({}));
export const action = defineHandler.withValidator({
  body: v.object({
    email: v.pipe(v.string(), v.minLength(1, 'Email is required')),
    name: v.pipe(v.string(), v.minLength(1, 'Name is required')),
    profile: v.object({ name: v.string() }),
    tags: v.array(v.string()),
  }),
})(() => {});
