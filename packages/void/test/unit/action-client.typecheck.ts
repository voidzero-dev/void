import { expectTypeOf } from 'vite-plus/test';
import { createActionClient } from '../../src/pages/client.ts';
import type { ActionResult } from '../../src/pages/client.ts';
import type { ParseActionUrl, ResolveActionBody } from '../../src/routes-stub.ts';

const { action } = createActionClient();

expectTypeOf(action('/__action-test/static')).toEqualTypeOf<Promise<ActionResult>>();
void action('/__action-test/static', { data: { name: 'Alice' }, method: 'DELETE' });
void action('/__action-test/users/:id?save', { params: { id: '1' }, data: { name: 'Alice' } });
void action('/__action-test/users/:id?save&tab=profile&page=2', {
  params: { id: '1' },
  data: { name: 'Alice' },
});
void action('/__action-test/users/[id]?save&tab=profile', {
  params: { id: '1' },
  data: { name: 'Alice' },
});
expectTypeOf<ParseActionUrl<'/__action-test/users/:id?save&tab=profile&page=2'>>().toEqualTypeOf<{
  base: '/__action-test/users/:id';
  action: 'save';
}>();
expectTypeOf<ResolveActionBody<'/__action-test/users/:id?save&tab=profile'>>().toEqualTypeOf<{
  name: string;
}>();

// @ts-expect-error Dynamic actions require parameters.
void action('/__action-test/users/:id?save');
// @ts-expect-error Parameterless actions do not accept parameters.
void action('/__action-test/static', { params: { id: '1' } });
// @ts-expect-error Action bodies retain their generated types.
void action('/__action-test/static', { data: { name: 1 } });
// @ts-expect-error Named actions retain their generated body types.
void action('/__action-test/users/:id?save', { params: { id: '1' }, data: { name: 1 } });
// @ts-expect-error Actions only accept mutation methods.
void action('/__action-test/static', { method: 'GET' });
// @ts-expect-error Only known named actions are accepted.
void action('/__action-test/users/:id?missing', { params: { id: '1' } });
// @ts-expect-error Query parameters do not allow unknown named actions.
void action('/__action-test/users/:id?missing&tab=profile', { params: { id: '1' } });
void action('/__action-test/users/:id?save&tab=profile', {
  params: { id: '1' },
  // @ts-expect-error Query parameters do not loosen action body validation.
  data: { name: 1 },
});
// @ts-expect-error Dynamic action parameters remain required with query parameters.
void action('/__action-test/users/:id?save&tab=profile');
