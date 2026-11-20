/** Arguments of `void project security …` (spec §13.3). */

export const SECURITY_COMMENT_MAX_CHARS = 4000;
const SECURITY_ACTIONS = [
  'status',
  'list',
  'show',
  'comment',
  'resolve',
  'reopen',
  'severity',
  'scans',
  'scan',
  'check',
  'model',
  'budget',
  'open',
] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'];
const STATES = ['open', 'resolved', 'all'];
const REASONS: Record<string, 'fixed' | 'false_positive' | 'accepted_risk'> = {
  fixed: 'fixed',
  'false-positive': 'false_positive',
  'accepted-risk': 'accepted_risk',
};
const MAX_BUDGET_USD = 10_000;

export type SecurityResolutionReason = 'fixed' | 'false_positive' | 'accepted_risk';

export type ProjectSecurityArgs = {
  subcommand: 'security';
  projectSlug: string;
  json: boolean;
} & (
  | { action: '' | 'status' | 'open' }
  | {
      action: 'list';
      urgent: boolean;
      state: 'open' | 'resolved' | 'all';
      severity: string | null;
      leads: boolean;
      /** M31: `sarif` prints a SARIF 2.1.0 log instead of the table. */
      format: 'text' | 'sarif';
    }
  | { action: 'show'; id: string }
  | { action: 'comment'; id: string; text: string }
  | { action: 'resolve'; ids: Array<string>; reason: SecurityResolutionReason; comment: string }
  | { action: 'reopen'; id: string; comment: string }
  /** M35: `severity` is `null` for `scan` (use the scan value again). */
  | { action: 'severity'; id: string; severity: string | null; comment: string }
  | { action: 'scans'; limit: number }
  | { action: 'scan'; yes: boolean; clientAssets: boolean }
  /** M32: scan the local tree (`checkId` empty), or show / wait for an earlier check. */
  | { action: 'check'; checkId: string; yes: boolean; wait: boolean }
  | {
      action: 'model';
      change: 'show' | 'set' | 'default';
      model: string;
      acceptNotice: boolean;
    }
  | { action: 'budget'; change: 'show' | 'set' | 'off'; usd: number }
);

const VALUE_FLAGS = new Set([
  '--project',
  '--reason',
  '--comment',
  '--state',
  '--severity',
  '--limit',
  '--usd',
  '--format',
]);
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--urgent',
  '--leads',
  '--default',
  '--accept-provider-notice',
  '--off',
  '--yes',
  '--client-assets',
  '--no-wait',
]);
// Flags each action accepts besides `--project` and `--json`.
const ACTION_FLAGS: Record<string, Array<string>> = {
  status: [],
  open: [],
  list: ['--urgent', '--state', '--severity', '--leads', '--format'],
  show: [],
  comment: [],
  resolve: ['--reason', '--comment'],
  reopen: ['--comment'],
  severity: ['--comment'],
  scans: ['--limit'],
  scan: ['--yes', '--client-assets'],
  check: ['--yes', '--no-wait'],
  model: ['--default', '--accept-provider-notice'],
  budget: ['--usd', '--off'],
};

/** `F-12`, `f-12` or `12` → `F-12`; anything else is `null`. */
export function normalizeFindingId(value: string): string | null {
  const text = value.trim();
  let digits = text;
  if (text[0] === 'F' || text[0] === 'f') {
    digits = text.slice(1);
    if (digits[0] === '-') {
      digits = digits.slice(1);
    }
  }
  if (digits.length === 0 || digits.length > 9 || digits.startsWith('0')) {
    return null;
  }
  for (const char of digits) {
    if (char < '0' || char > '9') {
      return null;
    }
  }
  return `F-${digits}`;
}

function parseFindingIds(values: Array<string>): Array<string> {
  const ids: Array<string> = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      if (part.trim() === '') {
        continue;
      }
      const id = normalizeFindingId(part);
      if (!id) {
        throw new Error(`project: '${part.trim()}' is not a finding id. Use a form like F-12.`);
      }
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/** A dollar amount with at most two decimals, as whole cents of precision. */
function parseUsd(value: string): number {
  const [whole = '', fraction = '', ...extra] = value.split('.');
  const digits = (text: string) => [...text].every((char) => char >= '0' && char <= '9');
  if (
    extra.length > 0 ||
    whole === '' ||
    !digits(whole) ||
    !digits(fraction) ||
    fraction.length > 2 ||
    value.includes('.') === (fraction === '')
  ) {
    throw new Error('project: --usd must be a dollar amount such as 40 or 12.50.');
  }
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd > MAX_BUDGET_USD) {
    throw new Error(`project: --usd must be at most ${MAX_BUDGET_USD}.`);
  }
  return usd;
}

function requireComment(value: string | undefined): string {
  const text = value?.trim() ?? '';
  if (text === '') {
    throw new Error(
      'project: A comment is required. Say why, for example: --comment "Added requireAdmin() in a1b2c3"',
    );
  }
  if ([...text].length > SECURITY_COMMENT_MAX_CHARS) {
    throw new Error(`project: A comment can be at most ${SECURITY_COMMENT_MAX_CHARS} characters.`);
  }
  return text;
}

export function parseSecurityArgs(rest: Array<string>): ProjectSecurityArgs {
  const [action = '', ...args] = rest;
  if (action !== '' && !(SECURITY_ACTIONS as ReadonlyArray<string>).includes(action)) {
    throw new Error(
      `project: Usage: void project security <${SECURITY_ACTIONS.join('|')}> [--project <slug>] [--json].`,
    );
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: Array<string> = [];
  const allowed = new Set(['--project', '--json', ...(ACTION_FLAGS[action] ?? [])]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (BOOLEAN_FLAGS.has(arg) || VALUE_FLAGS.has(arg)) {
      if (!allowed.has(arg)) {
        throw new Error(`project: ${arg} is not used with security ${action || '<command>'}.`);
      }
      if (flags.has(arg) || values.has(arg)) {
        throw new Error(`project: Duplicate flag '${arg}'.`);
      }
      if (BOOLEAN_FLAGS.has(arg)) {
        flags.add(arg);
        continue;
      }
      const value = args[++index];
      // A comment may start with a dash; every other value is a word.
      const dashOk = arg === '--comment' || arg === '--usd';
      if (value === undefined || (!dashOk && value.startsWith('-'))) {
        throw new Error(`project: ${arg} requires a value.`);
      }
      values.set(arg, value);
    } else if (arg.startsWith('-') && !(action === 'comment' && positionals.length >= 1)) {
      throw new Error(`project: Unknown flag '${arg}'.`);
    } else {
      positionals.push(arg);
    }
  }
  const base = { subcommand: 'security' as const, projectSlug: values.get('--project') ?? '' };
  const json = flags.has('--json');
  const noPositionals = () => {
    if (positionals.length > 0) {
      throw new Error(`project: Unexpected argument '${positionals[0]}'.`);
    }
  };

  if (action === '') {
    noPositionals();
    return { ...base, json, action };
  }
  if (action === 'status' || action === 'open') {
    noPositionals();
    return { ...base, json, action };
  }
  if (action === 'list') {
    noPositionals();
    const state = values.get('--state') ?? 'open';
    if (!STATES.includes(state)) {
      throw new Error(`project: Invalid --state '${state}'. Use one of open|resolved|all.`);
    }
    const severity = values.get('--severity') ?? null;
    if (severity !== null && !SEVERITIES.includes(severity)) {
      throw new Error(
        `project: Invalid --severity '${severity}'. Use one of ${SEVERITIES.join('|')}.`,
      );
    }
    const format = values.get('--format') ?? 'text';
    if (format !== 'text' && format !== 'sarif') {
      throw new Error(`project: Invalid --format '${format}'. Use text or sarif.`);
    }
    if (format === 'sarif' && json) {
      throw new Error('project: Use --format sarif or --json, not both.');
    }
    return {
      ...base,
      json,
      action,
      format,
      urgent: flags.has('--urgent'),
      state: state as 'open' | 'resolved' | 'all',
      severity,
      leads: flags.has('--leads'),
    };
  }
  if (action === 'show' || action === 'reopen') {
    if (positionals.length !== 1) {
      throw new Error(
        `project: Usage: void project security ${action} <F-id>${action === 'reopen' ? ' --comment "<text>"' : ''}.`,
      );
    }
    const id = parseFindingIds(positionals)[0];
    if (!id) {
      throw new Error(`project: '${positionals[0]}' is not a finding id. Use a form like F-12.`);
    }
    if (action === 'show') {
      return { ...base, json, action, id };
    }
    return { ...base, json, action, id, comment: requireComment(values.get('--comment')) };
  }
  if (action === 'comment') {
    if (positionals.length !== 2) {
      throw new Error('project: Usage: void project security comment <F-id> "<text>".');
    }
    const id = parseFindingIds([positionals[0]!])[0];
    if (!id) {
      throw new Error(`project: '${positionals[0]}' is not a finding id. Use a form like F-12.`);
    }
    return { ...base, json, action, id, text: requireComment(positionals[1]) };
  }
  if (action === 'resolve') {
    const ids = parseFindingIds(positionals);
    if (ids.length === 0) {
      throw new Error(
        'project: Usage: void project security resolve <F-id>… --reason fixed|false-positive|accepted-risk --comment "<text>".',
      );
    }
    const reasonText = values.get('--reason');
    const reason = reasonText === undefined ? undefined : REASONS[reasonText];
    if (!reason) {
      throw new Error('project: --reason is required: fixed, false-positive or accepted-risk.');
    }
    return { ...base, json, action, ids, reason, comment: requireComment(values.get('--comment')) };
  }
  if (action === 'severity') {
    const usage = `project: Usage: void project security severity <F-id> <${SEVERITIES.join('|')}|scan> --comment "<text>".`;
    if (positionals.length !== 2) {
      throw new Error(usage);
    }
    const id = parseFindingIds([positionals[0]!])[0];
    if (!id) {
      throw new Error(`project: '${positionals[0]}' is not a finding id. Use a form like F-12.`);
    }
    const level = positionals[1]!;
    if (level !== 'scan' && !SEVERITIES.includes(level)) {
      throw new Error(
        `project: Invalid severity '${level}'. Use one of ${SEVERITIES.join('|')}, or scan to use the scan severity again.`,
      );
    }
    return {
      ...base,
      json,
      action,
      id,
      severity: level === 'scan' ? null : level,
      comment: requireComment(values.get('--comment')),
    };
  }
  if (action === 'scans') {
    noPositionals();
    const text = values.get('--limit');
    let limit = 10;
    if (text !== undefined) {
      limit = Number(text);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('project: --limit must be a whole number from 1 to 100.');
      }
    }
    return { ...base, json, action, limit };
  }
  if (action === 'scan') {
    noPositionals();
    return {
      ...base,
      json,
      action,
      yes: flags.has('--yes'),
      clientAssets: flags.has('--client-assets'),
    };
  }
  if (action === 'check') {
    if (positionals.length > 1) {
      throw new Error(`project: Unexpected argument '${positionals[1]}'.`);
    }
    const checkId = positionals[0] ?? '';
    if (checkId.length > 64) {
      throw new Error(`project: '${checkId.slice(0, 64)}…' is not a check id.`);
    }
    if (checkId !== '' && flags.has('--yes')) {
      throw new Error('project: --yes is used only when a new check starts.');
    }
    return {
      ...base,
      json,
      action,
      checkId,
      yes: flags.has('--yes'),
      wait: !flags.has('--no-wait'),
    };
  }
  if (action === 'model') {
    if (positionals.length > 1) {
      throw new Error(`project: Unexpected argument '${positionals[1]}'.`);
    }
    const useDefault = flags.has('--default');
    if (useDefault && positionals.length > 0) {
      throw new Error('project: Pass a model id or --default, not both.');
    }
    const acceptNotice = flags.has('--accept-provider-notice');
    if (acceptNotice && !useDefault && positionals.length === 0) {
      throw new Error('project: --accept-provider-notice needs a model id or --default.');
    }
    return {
      ...base,
      json,
      action,
      change: useDefault ? 'default' : positionals.length > 0 ? 'set' : 'show',
      model: positionals[0] ?? '',
      acceptNotice,
    };
  }
  // budget
  noPositionals();
  const usdText = values.get('--usd');
  if (usdText !== undefined && flags.has('--off')) {
    throw new Error('project: Pass --usd <amount> or --off, not both.');
  }
  return {
    ...base,
    json,
    action: 'budget',
    change: flags.has('--off') ? 'off' : usdText === undefined ? 'show' : 'set',
    usd: usdText === undefined ? 0 : parseUsd(usdText),
  };
}
