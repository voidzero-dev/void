import { array, minLength, object, pipe, string } from 'valibot';
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({}));
export const action = defineHandler.withValidator({
  body: object({
    email: pipe(string(), minLength(1, 'Email is required')),
    name: pipe(string(), minLength(1, 'Name is required')),
    profile: object({ name: string() }),
    tags: array(string()),
  }),
})(() => {});
