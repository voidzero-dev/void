/**
 * `Symbol.for` key of the process-global `void/env` registry.
 *
 * Code that is bundled apart from an app, such as the cron and queue jobs that `void deploy`
 * compiles for a framework Worker, reaches the app's copy of `void/env` through this key. This
 * module is a leaf, so both the runtime and the CLI can import it.
 */
export const ENV_REGISTRY_KEY = 'void.env.registry';
