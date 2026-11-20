import type { CloudContext } from 'void';
import type { Child } from 'void/jsx';
import { GreetingContext } from '../components/greeting.ts';
import './styles.css';

export default async function Layout(c: CloudContext, children: Child) {
  const greeting = await Promise.resolve(c.req.query('greeting') || 'Hello');
  return (
    <GreetingContext.Provider value={greeting}>
      <div class="example-container">
        <header>
          <nav aria-label="Main navigation">
            <strong>
              <a href="/">Server Component Examples</a>
            </strong>
          </nav>
        </header>
        <hr />
        <main>{children}</main>
      </div>
    </GreetingContext.Provider>
  );
}
