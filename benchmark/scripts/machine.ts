import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      strict: true,
      options: { help: { type: 'boolean', short: 'h' } },
    });

    if (values.help) {
      console.log('Usage: node benchmark/scripts/machine.ts');
    } else {
      console.log(JSON.stringify(getMachineInfo()));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

interface NetworkInfo {
  type: 'wifi' | 'ethernet' | 'vpn' | 'loopback' | 'unknown';
  interface: string | null;
}

export function getMachineInfo() {
  const cpus = os.cpus();
  const platform = os.platform();

  return {
    hostnameSha256: createHash('sha256').update(os.hostname()).digest('hex'),
    platform,
    cpu: {
      models: [...new Set(cpus.map((cpu) => cpu.model))],
      architecture: os.arch(),
      logicalCores: cpus.length || null,
      availableParallelism: os.availableParallelism(),
    },
    network: getNetworkInfo(platform),
  };
}

function command(file: string, args: Array<string>) {
  const result = childProcess.spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    timeout: 1000,
    maxBuffer: 256 * 1024,
  });

  return result.status === 0 ? result.stdout : null;
}

function readText(file: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function linuxDefaultInterface() {
  const routes = (readText('/proc/net/route') ?? '')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (fields) =>
        fields[1] === '00000000' &&
        fields[7] === '00000000' &&
        (Number.parseInt(fields[3], 16) & 1) !== 0,
    )
    .sort((a, b) => Number(a[6]) - Number(b[6]));

  if (routes.length) {
    return routes[0][0];
  }

  const ipv6Routes = (readText('/proc/net/ipv6_route') ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (fields) =>
        fields[0] === '0'.repeat(32) &&
        fields[1] === '00' &&
        (Number.parseInt(fields[8], 16) & 1) !== 0 &&
        (Number.parseInt(fields[8], 16) & 0x200) === 0,
    )
    .sort((a, b) => Number.parseInt(a[5], 16) - Number.parseInt(b[5], 16));

  return ipv6Routes[0]?.[9] ?? null;
}

function getNetworkInfo(platform: string): NetworkInfo {
  const network: NetworkInfo = { type: 'unknown', interface: null };

  // Inspect local routing/link metadata only; never contact an external service.
  try {
    if (platform === 'darwin') {
      const route =
        command('/sbin/route', ['-n', 'get', 'default']) ??
        command('/sbin/route', ['-n', 'get', '-inet6', 'default']);
      network.interface = route?.match(/^\s*interface:\s*(\S+)/m)?.[1] ?? null;
    } else if (platform === 'linux') {
      network.interface = linuxDefaultInterface();
    }

    const device = network.interface;

    if (!device) {
      return network;
    }

    if (/^(?:utun|tun|tap|wg|ppp|ipsec|tailscale)/.test(device)) {
      network.type = 'vpn';
    } else if (/^lo\d*$/.test(device)) {
      network.type = 'loopback';
    } else if (platform === 'darwin') {
      const ports = command('/usr/sbin/networksetup', ['-listallhardwareports']) ?? '';
      const port = ports
        .split(/\r?\n\s*\r?\n/)
        .find((block) => block.match(/^Device:\s*(\S+)/m)?.[1] === device)
        ?.match(/^Hardware Port:\s*(.+)/m)?.[1];

      if (/wi-fi|airport/i.test(port ?? '')) {
        network.type = 'wifi';
      } else if (/ethernet|\bLAN\b/i.test(port ?? '')) {
        network.type = 'ethernet';
      }
    } else if (platform === 'linux') {
      if (fs.existsSync(`/sys/class/net/${device}/wireless`)) {
        network.type = 'wifi';
      } else if (readText(`/sys/class/net/${device}/type`)?.trim() === '1') {
        network.type = 'ethernet';
      }
    }
  } catch {
    // Missing commands, restricted containers, and unavailable OS metadata are nonfatal.
  }

  return network;
}
