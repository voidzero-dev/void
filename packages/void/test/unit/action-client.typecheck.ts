import { expectTypeOf } from 'vite-plus/test';
import { createActionClient, type ActionResult } from '../../src/pages/client.ts';
import type { ParseActionUrl, ResolveActionBody } from '../../src/routes-stub.ts';

const { action } = createActionClient();

expectTypeOf(action('/__action-test/static')).toEqualTypeOf<Promise<ActionResult>>();
action('/__action-test/static', { data: { name: 'Alice' }, method: 'DELETE' });
action('/__action-test/users/:id?save', { params: { id: '1' }, data: { name: 'Alice' } });
action('/__action-test/users/:id?save&tab=profile&page=2', {
  params: { id: '1' },
  data: { name: 'Alice' },
});
action('/__action-test/users/[id]?save&tab=profile', {
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
action('/__action-test/users/:id?save');
// @ts-expect-error Parameterless actions do not accept parameters.
action('/__action-test/static', { params: { id: '1' } });
// @ts-expect-error Action bodies retain their generated types.
action('/__action-test/static', { data: { name: 1 } });
// @ts-expect-error Named actions retain their generated body types.
action('/__action-test/users/:id?save', { params: { id: '1' }, data: { name: 1 } });
// @ts-expect-error Actions only accept mutation methods.
action('/__action-test/static', { method: 'GET' });
// @ts-expect-error Only known named actions are accepted.
action('/__action-test/users/:id?missing', { params: { id: '1' } });
// @ts-expect-error Query parameters do not allow unknown named actions.
action('/__action-test/users/:id?missing&tab=profile', { params: { id: '1' } });
// @ts-expect-error Query parameters do not loosen action body validation.
action('/__action-test/users/:id?save&tab=profile', { params: { id: '1' }, data: { name: 1 } });
// @ts-expect-error Dynamic action parameters remain required with query parameters.
action('/__action-test/users/:id?save&tab=profile');
