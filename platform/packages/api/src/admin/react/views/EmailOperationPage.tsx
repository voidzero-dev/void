/** @jsxImportSource react */

import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';

export function EmailOperationPage({
  label,
  status,
  error,
  operationId,
  platformName,
  username,
}: {
  label: string;
  status: string;
  error?: string | null;
  operationId?: string;
  projectId: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title={label} username={username}>
      <SectionStack>
        <h1>
          {label} {status}
        </h1>
        <p>{error ?? 'The operation has not completed. Check its status before retrying.'}</p>
        <p>
          Operation ID: <code>{operationId ?? 'unavailable'}</code>
        </p>
      </SectionStack>
    </Layout>
  );
}
