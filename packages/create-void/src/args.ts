export type CreateArgs = {
  appName: string | undefined;
  initArgs: Array<string>;
};

// run() spawns through a shell on Windows, so only forward plain flags such as
// `--framework react` or `--deploy=none` to `void init`.
const INIT_ARG_PATTERN = /^[\w=-]+$/;

export function validateProjectName(value: string | undefined): string | undefined {
  if (value && !value.trim()) {
    return 'Project name cannot be blank';
  }
  if (value !== undefined && value !== value.toLowerCase()) {
    return 'Project name must be lowercase';
  }
  // The prompt uses an empty value to select its default project name.
  if (!value) {
    return undefined;
  }
  // Keep scaffold names usable as workers.dev DNS labels.
  // https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#limitations
  if (value.length > 63) {
    return 'Project name must be at most 63 characters';
  }
  if (/[^a-z0-9-]/.test(value)) {
    return 'Project name must contain only lowercase letters, numbers, and dashes';
  }
  if (value.startsWith('-') || value.endsWith('-')) {
    return 'Project name cannot start or end with a dash';
  }
  return undefined;
}

/** Split `create-void [name] [void init options]` into the name and the options. */
export function parseCreateArgs(argv: ReadonlyArray<string>): CreateArgs {
  const [first, ...rest] = argv;
  const appName = first !== undefined && !first.startsWith('-') ? first : undefined;
  const nameError = validateProjectName(appName);
  if (nameError) {
    throw new Error(`create-void: ${nameError}`);
  }
  const initArgs = appName === undefined ? [...argv] : rest;
  for (const arg of initArgs) {
    if (!INIT_ARG_PATTERN.test(arg)) {
      throw new Error(`create-void: Unsupported argument '${arg}'.`);
    }
  }
  return { appName, initArgs };
}
