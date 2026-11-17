import { demoSections } from '../components/demos.ts';
import { SourceLink } from '../components/SourceLink.tsx';

export default function Home() {
  return (
    <>
      <h1>Server Component Examples</h1>
      <p>Explore Void Server Components examples organized by theme.</p>
      {demoSections.map(({ id, title, examples }) => (
        <div key={id}>
          <hr />
          <section aria-labelledby={id}>
            <h2 id={id}>{title}</h2>
            <div class="examples">
              {examples.map(({ title, description, source, path }) => (
                <section class="example" key={path}>
                  <h3>{title}</h3>
                  <SourceLink file={source} />
                  <p>{description}</p>
                  <p>
                    <a href={path}>See example</a>
                  </p>
                </section>
              ))}
            </div>
          </section>
        </div>
      ))}
    </>
  );
}
