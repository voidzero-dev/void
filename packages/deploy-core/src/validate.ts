import { isRecord } from './is-record.ts';

export const MANIFEST_REDIRECT_RULE_STATUSES: ReadonlySet<number> = new Set([
  200, 301, 302, 303, 307, 308,
]);

// Each rule compiles a regex per request in dispatch, so cap every list at deploy ingest.
export const MAX_ROUTING_RULES = 2000;
export const MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES: number = MAX_ROUTING_RULES;
const MAX_PAGES = 5000;
// Each distinct cron expression becomes one queue message and one Worker call per matching minute.
const MAX_CRON_EXPRESSIONS = 100;
// The scheduler parses every entry, shared expression or not, on each alarm.
const MAX_SCHEDULES = 1000;

const LITERAL_HOSTNAME_REGEX = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

type RoutingRuleKind = 'redirectRules' | 'fallbackRules';

// Lowercases `host` in place: dispatch compares the stored form with the lowercase `url.hostname`.
function validateRuleHost(
  rule: Record<string, unknown>,
  kind: RoutingRuleKind,
  sourceRef: string,
): string | null {
  if (rule.host === undefined) {
    return null;
  }
  if (typeof rule.host !== 'string') {
    return `invalid manifest shape: ${kind} entry ${sourceRef} host must be a string`;
  }
  const normalized = rule.host.toLowerCase();
  if (!LITERAL_HOSTNAME_REGEX.test(normalized)) {
    return `invalid manifest shape: ${kind} entry ${sourceRef} host must be a literal hostname (e.g. "www.example.com"; no scheme, port, path, or wildcards): ${JSON.stringify(rule.host)}`;
  }
  rule.host = normalized;
  return null;
}

function validateRoutingRules(rules: unknown, kind: RoutingRuleKind): string | null {
  if (rules === undefined) {
    return null;
  }
  if (!Array.isArray(rules)) {
    return `invalid manifest shape: ${kind} must be an array`;
  }
  if (rules.length > MAX_ROUTING_RULES) {
    return `invalid manifest shape: ${kind} has ${rules.length} entries, exceeds the ${MAX_ROUTING_RULES} per-list limit`;
  }
  const rewritesOnly = kind === 'fallbackRules';
  for (const rule of rules) {
    if (!isRecord(rule)) {
      return `invalid manifest shape: ${kind} entries must be objects`;
    }
    if (
      typeof rule.source !== 'string' ||
      typeof rule.destination !== 'string' ||
      typeof rule.status !== 'number'
    ) {
      return `invalid manifest shape: ${kind} entries must have string source, string destination, and numeric status`;
    }
    const sourceRef = JSON.stringify(rule.source);
    if (rewritesOnly && rule.status !== 200) {
      return `invalid manifest shape: ${kind} entry ${sourceRef} status must be 200 (fallbacks are rewrites only)`;
    }
    if (!rewritesOnly && !MANIFEST_REDIRECT_RULE_STATUSES.has(rule.status)) {
      return `invalid manifest shape: ${kind} entry ${sourceRef} status must be one of ${[...MANIFEST_REDIRECT_RULE_STATUSES].join(', ')} (200 = rewrite, 3xx = redirect)`;
    }
    // Rewrites (status 200) must stay internal: dispatch merges the request query itself, and
    // `//evil.com/x` parses cross-origin. 3xx redirects may carry a query and external Location.
    if (rule.status === 200) {
      const condition = rewritesOnly ? '' : ' when status is 200';
      if (rule.destination.includes('?')) {
        return `invalid manifest shape: ${kind} entry ${sourceRef} destination must not contain a query string${condition}`;
      }
      if (!rule.destination.startsWith('/')) {
        return `invalid manifest shape: ${kind} entry ${sourceRef} destination must be path-absolute (start with "/")${condition}`;
      }
      if (rule.destination.startsWith('//')) {
        return `invalid manifest shape: ${kind} entry ${sourceRef} destination must not start with "//" (protocol-relative URLs parse cross-origin; use a single-slash path-absolute destination)`;
      }
    }
    const hostError = validateRuleHost(rule, kind, sourceRef);
    if (hostError) {
      return hostError;
    }
  }
  return null;
}

function validateClassMigrations(
  path: string,
  migrations: unknown,
  fields: ReadonlyArray<string>,
  requireNonEmptyTag = false,
): string | null {
  if (migrations === undefined) {
    return null;
  }
  if (!Array.isArray(migrations)) {
    return `invalid manifest shape: ${path} must be an array`;
  }
  for (const migration of migrations) {
    if (!isRecord(migration)) {
      return `invalid manifest shape: ${path} entries must be objects`;
    }
    if (typeof migration.tag !== 'string' || (requireNonEmptyTag && migration.tag.length === 0)) {
      return `invalid manifest shape: ${path} entries must have a ${requireNonEmptyTag ? 'non-empty ' : ''}string tag`;
    }
    for (const field of fields) {
      const value = migration[field];
      if (
        value !== undefined &&
        (!Array.isArray(value) || !value.every((className) => typeof className === 'string'))
      ) {
        return `invalid manifest shape: ${path} ${field} must be an array of strings`;
      }
    }
  }
  return null;
}

/**
 * Check the shape of an incoming deploy manifest. Returns an error message, or `null` when valid.
 * Deploy code reads the manifest without re-checking, so run this before creating any deploy state.
 */
export function validateManifestShape(manifest: unknown): string | null {
  if (!isRecord(manifest)) {
    return 'invalid manifest shape: expected a JSON object';
  }
  if (manifest.emailProtocolVersion !== undefined && manifest.emailProtocolVersion !== 1) {
    return 'invalid manifest shape: emailProtocolVersion must be 1';
  }

  if (!isRecord(manifest.bindings)) {
    return 'invalid manifest shape: bindings must be an object';
  }
  const bindings = manifest.bindings;
  for (const key of ['d1', 'kv', 'r2', 'hyperdrive'] as const) {
    const bindingValue = bindings[key];
    if (bindingValue === undefined) {
      continue;
    }
    if (!Array.isArray(bindingValue) || !bindingValue.every((value) => typeof value === 'string')) {
      return `invalid manifest shape: bindings.${key} must be an array of strings`;
    }
  }

  if (manifest.queues !== undefined) {
    if (!Array.isArray(manifest.queues)) {
      return 'invalid manifest shape: queues must be an array';
    }
    for (const queue of manifest.queues) {
      if (!isRecord(queue)) {
        return 'invalid manifest shape: queues entries must be objects';
      }
      if (typeof queue.name !== 'string' || typeof queue.bindingName !== 'string') {
        return 'invalid manifest shape: queues entries must have string name and bindingName';
      }
      for (const tuning of [
        'maxBatchSize',
        'maxBatchTimeout',
        'maxRetries',
        'retryDelay',
      ] as const) {
        const tuningValue = queue[tuning];
        if (tuningValue === undefined) {
          continue;
        }
        if (typeof tuningValue !== 'number' || !Number.isFinite(tuningValue)) {
          return `invalid manifest shape: queues entry ${tuning} must be a finite number`;
        }
      }
    }
  }

  if (manifest.schedules !== undefined) {
    if (!Array.isArray(manifest.schedules)) {
      return 'invalid manifest shape: schedules must be an array';
    }
    if (manifest.schedules.length > MAX_SCHEDULES) {
      return `invalid manifest shape: schedules has ${manifest.schedules.length} entries, exceeds the ${MAX_SCHEDULES} per-project limit`;
    }
    const cronExpressions = new Set<string>();
    for (const schedule of manifest.schedules) {
      if (!isRecord(schedule)) {
        return 'invalid manifest shape: schedules entries must be objects';
      }
      if (typeof schedule.name !== 'string' || typeof schedule.cron !== 'string') {
        return 'invalid manifest shape: schedules entries must have string name and cron';
      }
      cronExpressions.add(schedule.cron);
    }
    if (cronExpressions.size > MAX_CRON_EXPRESSIONS) {
      return `invalid manifest shape: schedules has ${cronExpressions.size} distinct cron expressions, exceeds the ${MAX_CRON_EXPRESSIONS} per-project limit`;
    }
  }

  if (manifest.prerender !== undefined) {
    if (
      !Array.isArray(manifest.prerender) ||
      !manifest.prerender.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: prerender must be an array of strings';
    }
  }

  if (manifest.vars !== undefined) {
    if (!isRecord(manifest.vars)) {
      return 'invalid manifest shape: vars must be an object';
    }
    for (const [k, v] of Object.entries(manifest.vars)) {
      if (typeof v !== 'string') {
        return `invalid manifest shape: vars.${k} must be a string`;
      }
    }
  }

  if (manifest.migrations !== undefined) {
    if (!isRecord(manifest.migrations)) {
      return 'invalid manifest shape: migrations must be an object';
    }
    const mig = manifest.migrations;
    // `dialect` and `pending` are read unconditionally by the migration
    // dispatch path (`manifest.migrations.pending > 0`). A wrong-typed value
    // would reach the CF migration runner and crash mid-deploy.
    if (mig.dialect !== undefined) {
      const allowed = ['sqlite', 'postgresql', 'mysql'];
      if (typeof mig.dialect !== 'string' || !allowed.includes(mig.dialect)) {
        return `invalid manifest shape: migrations.dialect must be one of ${allowed.join(', ')}`;
      }
    }
    if (mig.pending !== undefined) {
      if (typeof mig.pending !== 'number' || !Number.isInteger(mig.pending) || mig.pending < 0) {
        return 'invalid manifest shape: migrations.pending must be a non-negative integer';
      }
    }
    if (mig.protocolVersion !== undefined && mig.protocolVersion !== 2) {
      return 'invalid manifest shape: migrations.protocolVersion must be 2';
    }
    if (
      mig.classifierVersion !== undefined &&
      (typeof mig.classifierVersion !== 'number' || !Number.isInteger(mig.classifierVersion))
    ) {
      return 'invalid manifest shape: migrations.classifierVersion must be an integer';
    }
    if (mig.migrationListHash !== undefined && typeof mig.migrationListHash !== 'string') {
      return 'invalid manifest shape: migrations.migrationListHash must be a string';
    }
    if (mig.stability !== undefined && mig.stability !== 'stable' && mig.stability !== 'legacy') {
      return 'invalid manifest shape: migrations.stability must be stable or legacy';
    }
  }

  if (manifest.auth !== undefined && typeof manifest.auth !== 'boolean') {
    return 'invalid manifest shape: auth must be a boolean';
  }

  if (manifest.ssr !== undefined && typeof manifest.ssr !== 'boolean') {
    return 'invalid manifest shape: ssr must be a boolean';
  }

  for (const key of [
    'workerMain',
    'compatibilityDate',
    'hashedAssetsPrefix',
    'framework',
  ] as const) {
    if (manifest[key] !== undefined && typeof manifest[key] !== 'string') {
      return `invalid manifest shape: ${key} must be a string`;
    }
  }

  if (manifest.assetManifestVersion !== undefined) {
    // Direct-to-R2 deploys require v2 (declares blake3 + md5 + size per asset).
    // The handler enforces v2 with its own error message; this shape check
    // accepts 1 here so the layered error is the one users see.
    if (manifest.assetManifestVersion !== 1 && manifest.assetManifestVersion !== 2) {
      return 'invalid manifest shape: assetManifestVersion must be 1 or 2';
    }
  }

  if (manifest.compatibilityFlags !== undefined) {
    if (
      !Array.isArray(manifest.compatibilityFlags) ||
      !manifest.compatibilityFlags.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: compatibilityFlags must be an array of strings';
    }
  }

  // Per-project worker limit overrides (void.json `worker.limits`). Shape-only
  // here; the plan ceiling (`maxCpuMsPerRequest`) is enforced by the deploy
  // handler once the authenticated user's plan is in scope.
  if (manifest.limits !== undefined) {
    if (!isRecord(manifest.limits)) {
      return 'invalid manifest shape: limits must be an object';
    }
    const limits = manifest.limits;
    if (limits.cpuMs !== undefined) {
      if (
        typeof limits.cpuMs !== 'number' ||
        !Number.isSafeInteger(limits.cpuMs) ||
        limits.cpuMs < 1
      ) {
        return 'invalid manifest shape: limits.cpuMs must be a positive integer';
      }
    }
  }

  if (manifest.type !== undefined) {
    const allowed = ['void', 'spa', 'static', 'framework'];
    if (typeof manifest.type !== 'string' || !allowed.includes(manifest.type)) {
      return `invalid manifest shape: type must be one of ${allowed.join(', ')}`;
    }
  }

  if (manifest.assetConfig !== undefined) {
    if (!isRecord(manifest.assetConfig)) {
      return 'invalid manifest shape: assetConfig must be an object';
    }
    const assetConfig = manifest.assetConfig;
    if (
      assetConfig.not_found_handling !== undefined &&
      !['none', 'single-page-application', '404-page'].includes(
        assetConfig.not_found_handling as string,
      )
    ) {
      return 'invalid manifest shape: assetConfig.not_found_handling must be one of none, single-page-application, 404-page';
    }
    if (
      assetConfig.html_handling !== undefined &&
      !['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'].includes(
        assetConfig.html_handling as string,
      )
    ) {
      return 'invalid manifest shape: assetConfig.html_handling must be one of auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none';
    }
  }

  if (manifest.revalidate !== undefined && typeof manifest.revalidate !== 'number') {
    if (!isRecord(manifest.revalidate)) {
      return 'invalid manifest shape: revalidate must be a number or object';
    }
    for (const [pathname, value] of Object.entries(manifest.revalidate)) {
      if (typeof value !== 'number') {
        return `invalid manifest shape: revalidate.${pathname} must be a number`;
      }
    }
  }

  if (manifest.headerRules !== undefined) {
    if (!Array.isArray(manifest.headerRules)) {
      return 'invalid manifest shape: headerRules must be an array';
    }
    for (const rule of manifest.headerRules) {
      if (!isRecord(rule)) {
        return 'invalid manifest shape: headerRules entries must be objects';
      }
      if (typeof rule.pattern !== 'string') {
        return 'invalid manifest shape: headerRules entries must have a string pattern';
      }
      if (!Array.isArray(rule.headers)) {
        return 'invalid manifest shape: headerRules entries must have a headers array';
      }
      for (const pair of rule.headers) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== 'string' ||
          typeof pair[1] !== 'string'
        ) {
          return 'invalid manifest shape: headerRules headers entries must be [name, value] string pairs';
        }
      }
    }
  }

  if (manifest.alwaysUseHttps !== undefined && typeof manifest.alwaysUseHttps !== 'boolean') {
    return 'invalid manifest shape: alwaysUseHttps must be a boolean';
  }

  const redirectRulesError = validateRoutingRules(manifest.redirectRules, 'redirectRules');
  if (redirectRulesError) {
    return redirectRulesError;
  }

  if (manifest.revalidateQueryAllowlist !== undefined) {
    if (!isRecord(manifest.revalidateQueryAllowlist)) {
      return 'invalid manifest shape: revalidateQueryAllowlist must be an object';
    }
    const entries = Object.entries(manifest.revalidateQueryAllowlist);
    if (entries.length > MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES) {
      return `invalid manifest shape: revalidateQueryAllowlist has ${entries.length} entries, exceeds the ${MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES} entry limit`;
    }
    for (const [pattern, value] of entries) {
      if (pattern === '') {
        return 'invalid manifest shape: revalidateQueryAllowlist must not include an empty pattern';
      }
      if (!Array.isArray(value)) {
        return `invalid manifest shape: revalidateQueryAllowlist entry ${JSON.stringify(pattern)} must be an array of strings`;
      }
      for (const param of value) {
        if (typeof param !== 'string') {
          return `invalid manifest shape: revalidateQueryAllowlist entry ${JSON.stringify(pattern)} must contain only strings`;
        }
      }
    }
  }

  if (manifest.pages !== undefined) {
    if (!Array.isArray(manifest.pages)) {
      return 'invalid manifest shape: pages must be an array';
    }
    if (manifest.pages.length > MAX_PAGES) {
      return `invalid manifest shape: pages has ${manifest.pages.length} entries, exceeds the ${MAX_PAGES} entry limit`;
    }
    for (const entry of manifest.pages as Array<unknown>) {
      if (!isRecord(entry)) {
        return 'invalid manifest shape: each pages entry must be an object';
      }
      if (typeof entry.pattern !== 'string' || entry.pattern === '') {
        return 'invalid manifest shape: pages entry pattern must be a string';
      }
      if (entry.revalidate !== undefined && typeof entry.revalidate !== 'number') {
        return 'invalid manifest shape: pages entry revalidate must be a number';
      }
    }
  }

  if (manifest.pathRevalidate !== undefined) {
    if (!isRecord(manifest.pathRevalidate)) {
      return 'invalid manifest shape: pathRevalidate must be an object';
    }
    for (const [pathname, value] of Object.entries(manifest.pathRevalidate)) {
      if (typeof value !== 'number') {
        return `invalid manifest shape: pathRevalidate.${pathname} must be a number`;
      }
    }
  }

  const fallbackRulesError = validateRoutingRules(manifest.fallbackRules, 'fallbackRules');
  if (fallbackRulesError) {
    return fallbackRulesError;
  }

  if (manifest.websocket !== undefined) {
    if (!isRecord(manifest.websocket)) {
      return 'invalid manifest shape: websocket must be an object';
    }
    const websocket = manifest.websocket;
    if (!Array.isArray(websocket.routes)) {
      return 'invalid manifest shape: websocket.routes must be an array';
    }
    for (const route of websocket.routes) {
      if (!isRecord(route)) {
        return 'invalid manifest shape: websocket.routes entries must be objects';
      }
      if (typeof route.className !== 'string') {
        return 'invalid manifest shape: websocket.routes entries must have a string className';
      }
      if (route.bindingName !== undefined && typeof route.bindingName !== 'string') {
        return 'invalid manifest shape: websocket.routes entry bindingName must be a string';
      }
    }
    if (
      !Array.isArray(websocket.classes) ||
      !websocket.classes.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: websocket.classes must be an array of strings';
    }
    const migrationsError = validateClassMigrations(
      'websocket.migrations',
      websocket.migrations,
      ['newClasses', 'newSqliteClasses', 'deletedClasses'],
      true,
    );
    if (migrationsError) {
      return migrationsError;
    }
  }

  if (manifest.sandbox !== undefined) {
    // Static and SPA deploys create no Worker script, so a sandbox could never be wired.
    if (manifest.type === 'static' || manifest.type === 'spa') {
      return 'sandbox is not supported for static/spa deployments';
    }
    if (!isRecord(manifest.sandbox)) {
      return 'invalid manifest shape: sandbox must be an object';
    }
    const sandbox = manifest.sandbox;
    for (const key of ['bindingName', 'className', 'containerName', 'image']) {
      if (typeof sandbox[key] !== 'string' || sandbox[key].length === 0) {
        return `invalid manifest shape: sandbox.${key} must be a non-empty string`;
      }
    }
    if (isLocalImageReference(sandbox.image as string)) {
      return 'invalid manifest shape: sandbox.image must be a registry image reference';
    }
    if (sandbox.instanceType !== undefined && typeof sandbox.instanceType !== 'string') {
      return 'invalid manifest shape: sandbox.instanceType must be a string';
    }
    if (
      sandbox.maxInstances !== undefined &&
      (typeof sandbox.maxInstances !== 'number' ||
        !Number.isInteger(sandbox.maxInstances) ||
        sandbox.maxInstances < 1)
    ) {
      return 'invalid manifest shape: sandbox.maxInstances must be a positive integer';
    }
    const migrationsError = validateClassMigrations('sandbox.migrations', sandbox.migrations, [
      'newSqliteClasses',
      'deletedClasses',
    ]);
    if (migrationsError) {
      return migrationsError;
    }
  }

  if (manifest.live !== undefined) {
    if (!isRecord(manifest.live)) {
      return 'invalid manifest shape: live must be an object';
    }
    const live = manifest.live;
    for (const key of ['bindingName', 'className']) {
      if (typeof live[key] !== 'string' || live[key].length === 0) {
        return `invalid manifest shape: live.${key} must be a non-empty string`;
      }
    }
    if (live.storage !== 'sqlite') {
      return 'invalid manifest shape: live.storage must be "sqlite"';
    }
    if (!Array.isArray(live.classes) || !live.classes.every((x) => typeof x === 'string')) {
      return 'invalid manifest shape: live.classes must be an array of strings';
    }
    const migrationsError = validateClassMigrations('live.migrations', live.migrations, [
      'newSqliteClasses',
    ]);
    if (migrationsError) {
      return migrationsError;
    }
  }

  if (manifest.durableObjects !== undefined) {
    const durable = manifest.durableObjects;
    if (manifest.version !== 4 || !isRecord(durable) || !Array.isArray(durable.bindings)) {
      return 'invalid manifest shape: durableObjects requires manifest version 4 and a bindings array';
    }
    if (durable.bindings.length > 32) {
      return 'invalid manifest shape: at most 32 custom Durable Objects are supported';
    }
    const names = new Set<string>();
    const classes = new Set<string>();
    const otherBindings = new Set([
      ...Object.values(bindings).filter(Array.isArray).flat(),
      ...Object.keys(isRecord(manifest.vars) ? manifest.vars : {}),
      ...(Array.isArray(manifest.queues) ? manifest.queues.map((q) => q.bindingName) : []),
      ...(isRecord(manifest.websocket) && Array.isArray(manifest.websocket.routes)
        ? manifest.websocket.routes.map((r) => r.bindingName ?? r.className)
        : []),
      ...(isRecord(manifest.live) ? [manifest.live.bindingName] : []),
    ]);
    for (const binding of durable.bindings) {
      if (
        !isRecord(binding) ||
        Object.keys(binding).some(
          (key) => !['bindingName', 'className', 'storage'].includes(key),
        ) ||
        typeof binding.bindingName !== 'string' ||
        !/^[A-Za-z_$][\w$]{0,127}$/.test(binding.bindingName) ||
        binding.bindingName.startsWith('__') ||
        ['ASSETS', 'SEND_EMAIL', 'USAGE_EVENTS_QUEUE'].includes(binding.bindingName) ||
        typeof binding.className !== 'string' ||
        !/^[A-Za-z_$][\w$]{0,127}$/.test(binding.className) ||
        binding.storage !== 'sqlite'
      ) {
        return 'invalid manifest shape: custom Durable Objects require local SQLite classes and valid binding names';
      }
      if (
        names.has(binding.bindingName) ||
        classes.has(binding.className) ||
        otherBindings.has(binding.bindingName)
      ) {
        return 'invalid manifest shape: custom Durable Object bindings and classes must be unique';
      }
      names.add(binding.bindingName);
      classes.add(binding.className);
    }
  }
  return null;
}

function isLocalImageReference(image: string): boolean {
  return (
    image.startsWith('.') || image.startsWith('/') || image.toLowerCase().includes('dockerfile')
  );
}
