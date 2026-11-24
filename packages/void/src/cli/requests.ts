import { log, outro } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import { PlatformClient, type RequestEntry } from './client.ts';
import { dim, pc } from './output.ts';
import { readProjectConfig } from './project.ts';

export async function runRequestsCommand(
  root: string,
  range: string,
  status?: string,
): Promise<void> {
  console.log();

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  if (!/^\d+(m|h|d)$/.test(range)) {
    log.error(`requests: Invalid range '${range}'. Use a format like 15m, 2h, or 3d.`);
    process.exit(1);
  }

  const linked = readProjectConfig(root);
  if (!linked) {
    log.error('No linked project. Run `void project link` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  let entries: Array<RequestEntry>;
  try {
    entries = await client.getRequests(linked.projectId, range, 200, status || undefined);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (entries.length === 0) {
    const suffix = status ? ` matching status ${status}` : '';
    outro(`No requests found in the last ${range}${suffix}.`);
    return;
  }

  for (const entry of entries) {
    printRequest(entry);
  }

  outro(dim(`${entries.length} requests`));
}

function printRequest(entry: RequestEntry): void {
  const time = formatTime(entry.timestamp);
  const method = (entry.method || '-').padEnd(4);
  const status = entry.status || '-';

  const statusNum = Number.parseInt(status, 10);
  const coloredStatus =
    statusNum >= 500 ? pc.red(status) : statusNum >= 400 ? pc.yellow(status) : status;

  const duration = Number.isFinite(entry.durationMs)
    ? dim(`${Math.round(entry.durationMs)}ms`)
    : '';
  console.log(`${dim(time)} ${method} ${coloredStatus} ${dim(entry.type)} ${duration}`.trimEnd());
}

// Analytics Engine returns `YYYY-MM-DD HH:MM:SS` in UTC (no zone); parse as UTC
// and render in the local timezone, matching `project logs`.
function formatTime(ts: string): string {
  const d = new Date(`${ts.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString('en-GB', { hour12: false });
}
