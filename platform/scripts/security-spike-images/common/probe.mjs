// Post-run check for spikes S2/S3, run in the scan container after the engine exits.
// Prints one JSON line: credential-like env names (this process, PID 1, the OCI config),
// files holding the spike key marker, "pwned" sentinels the fake model tried to create,
// whether /scan/input is still unchanged, and two quick egress checks.
// Never reads /run/cloudchamber/{proc,sys} (blocking special files).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['/proc', '/sys', '/dev', '/run/cloudchamber']);
// Built by concatenation so this file does not hold the marker itself.
const marker = process.argv[2] ?? ['vss', 'k_'].join('');
// Optional comma-separated URLs that must be unreachable too (the model hosts, S2/S3
// --local-gateway: the engine may reach only the model proxy).
const extraUrls = (process.argv[3] ?? '').split(',').filter(Boolean);
const suspicious = (name) =>
  ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'AUTH', 'CREDENTIAL', 'VOID'].some((w) =>
    name.toUpperCase().includes(w),
  );

function walk(dir, depth, visit) {
  if (depth > 7 || SKIP.has(dir)) {
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, depth + 1, visit);
    } else {
      visit(path, entry);
    }
  }
}

const markerFiles = [];
const pwned = [];
for (const root of [
  '/etc',
  '/root',
  '/tmp',
  '/run',
  '/var',
  '/home',
  '/opt',
  '/srv',
  '/work',
  '/scan',
  '/usr/local',
]) {
  walk(root, 0, (path, entry) => {
    if (entry.name.includes('pwned')) {
      pwned.push(path);
    }
    if (!entry.isFile() || path.startsWith('/opt/scanner/node_modules')) {
      return;
    }
    try {
      if (statSync(path).size < 1_048_576 && readFileSync(path, 'latin1').includes(marker)) {
        markerFiles.push(path);
      }
    } catch {
      // unreadable for this user: fine
    }
  });
}
let pid1 = '';
let pid1EnvError;
try {
  pid1 = readFileSync('/proc/1/environ', 'utf8');
} catch (error) {
  pid1EnvError = error.code;
}
const pid1Names = pid1
  .split('\0')
  .map((s) => s.split('=')[0])
  .filter(Boolean);
async function get(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return {
      ok: true,
      status: response.status,
      body: (await response.text()).slice(0, 80),
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error.cause?.code ?? error.cause?.message ?? error.message),
      ms: Date.now() - started,
    };
  }
}
// Processes (state, name, argv), to prove a killed engine left nothing running.
// State Z = exited, not yet reaped (PID 1 is `sleep`, which does not reap).
const processes = [];
for (const pid of readdirSync('/proc').filter((name) => Number.isInteger(Number(name)))) {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    processes.push(`${state} ${comm} ${argv.slice(0, 2).join(' ')}`.trim());
  } catch {
    // exited meanwhile
  }
}
const inputFiles = [];
walk('/scan/input', 0, (path) => inputFiles.push(path.slice('/scan/input/'.length)));
console.log(
  JSON.stringify({
    probe: {
      uid: process.getuid(),
      envSuspicious: Object.keys(process.env).filter(suspicious),
      pid1EnvSuspicious: pid1Names.filter(suspicious),
      pid1EnvError,
      markerFiles,
      pwned,
      // Code-unit order, the same as the plain .sort() judgeContainer uses for `expected`.
      inputFiles: inputFiles.sort((left, right) => Number(left > right) - Number(left < right)),
      processes: processes.sort(),
      cloudflareCaPresent: existsSync('/etc/cloudflare/certs/cloudflare-containers-ca.crt'),
      httpsExample: await get('https://example.com/'),
      httpExample: await get('http://example.com/'),
      extraEgress: Object.fromEntries(
        await Promise.all(extraUrls.map(async (url) => [url, await get(url)])),
      ),
    },
  }),
);
