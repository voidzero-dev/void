import { it } from 'vite-plus/test';
import dispatch from '../../src/index.ts';

it('delivers platform batches to a generated framework consumer and applies its decisions', async () => {
  // Keep the Node/Vite artifact builder out of the Worker's type environment.
  const source = new URL(
    '../../../../../packages/void/test/helpers/framework-queue-contract.ts',
    (import.meta as ImportMeta & { url: string }).url,
  );
  const { assertFrameworkQueueDelivery } = (await import(source.href)) as {
    assertFrameworkQueueDelivery(dispatcher: typeof dispatch): Promise<void>;
  };
  await assertFrameworkQueueDelivery(dispatch);
});
