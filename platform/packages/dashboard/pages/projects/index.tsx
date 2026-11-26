import type { Props } from './index.server.ts';

export const layout = 'dashboard';

export default function ProjectsPage({ projects, error }: Props) {
  return (
    <main className="dashboard-main">
      <section className="wrapper wrapper--ticks dashboard-page security-page">
        <h1 className="dashboard-heading">Projects</h1>
        {error && <p className="security-notice security-notice--error">{error}</p>}
        {!error && projects.length === 0 && (
          <p className="dashboard-description">You are not a member of any project yet.</p>
        )}
        {projects.length > 0 && (
          <ul className="security-list">
            {projects.map((project) => (
              <li key={project.slug}>
                <strong>{project.slug}</strong> · {project.role} ·{' '}
                <a href={`/projects/${encodeURIComponent(project.slug)}/security`}>Security</a>
              </li>
            ))}
          </ul>
        )}
        <a href="/">Back to account</a>
      </section>
    </main>
  );
}
