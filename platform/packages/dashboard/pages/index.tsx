import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import type { Props } from './index.server.ts';

export const layout = 'dashboard';

export default function AuthenticatedPage({ user }: Props) {
  return (
    <main className="dashboard-main">
      <section className="wrapper wrapper--ticks dashboard-page dashboard-home">
        <VStack gap={5}>
          <VStack gap={2}>
            <h1 className="dashboard-heading">You’re signed in.</h1>
            <p className="dashboard-description">
              Authenticated as <strong className="dashboard-identity">{user.login}</strong>.
            </p>
          </VStack>
          <HStack gap={2} wrap="wrap">
            <Button href="/projects" label="Projects" />
            <Button href="/account" label="Manage login methods" variant="secondary" />
            <Button href="/logout" label="Sign out" variant="secondary" />
          </HStack>
        </VStack>
      </section>
    </main>
  );
}
