import { array, object, string } from 'valibot';
import { defineHandler } from 'void';

export const loader = defineHandler(() => ({}));

export const action = defineHandler.withValidator({
  body: object({ profile: object({ name: string() }), tags: array(string()) }),
})(() => {});
