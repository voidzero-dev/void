/**
 * Mailbox names on the shared mail domain. A project receives and sends at
 * `<name>[+tag]@<shared domain>`, where `<name>` is its slug or, once set, its
 * email alias. The slug keeps working after an alias is set, so addresses that
 * are already in use do not break. The alias is the address the project shows.
 */
type MailboxProject = Readonly<{ slug: string; email_alias: string | null }>;

/** Every name that addresses the project, slug first. */
export function projectMailboxNames(project: MailboxProject): ReadonlyArray<string> {
  return project.email_alias ? [project.slug, project.email_alias] : [project.slug];
}

/** The name the project shows: its alias when it has one, else its slug. */
export function projectMailbox(project: MailboxProject): string {
  return project.email_alias ?? project.slug;
}
