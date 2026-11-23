/**
 * Private-address checks for remote image hosts. Next.js resolves hostnames
 * and rejects any address `ipaddr.js` does not classify as `unicast`. Workers
 * cannot resolve DNS, so Void checks the literal host after WHATWG URL
 * normalization (which already turns `0x7f.1` and `2130706433` into
 * `127.0.0.1`), plus `localhost` and `*.localhost`, which a dev server reaches.
 */

type Range = readonly [prefix: ReadonlyArray<number>, bits: number];

// ipaddr.js 2.x IPv4 special ranges: unspecified, broadcast, multicast,
// linkLocal, loopback, carrierGradeNat, private, reserved, as112 and amt.
const IPV4_RANGES: ReadonlyArray<Range> = [
  [[0, 0, 0, 0], 8],
  [[255, 255, 255, 255], 32],
  [[224, 0, 0, 0], 4],
  [[169, 254, 0, 0], 16],
  [[127, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[10, 0, 0, 0], 8],
  [[172, 16, 0, 0], 12],
  [[192, 168, 0, 0], 16],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[240, 0, 0, 0], 4],
  [[192, 175, 48, 0], 24],
  [[192, 31, 196, 0], 24],
  [[192, 52, 193, 0], 24],
];

// ipaddr.js 2.x IPv6 special ranges. `::/96` (IPv4-compatible, deprecated) is
// a Void addition: those hosts are classified like the IPv4 address they embed.
const IPV6_RANGES: ReadonlyArray<Range> = [
  [[0, 0, 0, 0, 0, 0, 0, 0], 128],
  [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10],
  [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8],
  [[0, 0, 0, 0, 0, 0, 0, 1], 128],
  [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7],
  [[0x100, 0, 0, 0, 0, 0, 0, 0], 64],
  [[0, 0, 0, 0, 0xffff, 0, 0, 0], 96],
  [[0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96],
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16],
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 32],
  [[0x2001, 2, 0, 0, 0, 0, 0, 0], 48],
  [[0x2001, 3, 0, 0, 0, 0, 0, 0], 32],
  [[0x2001, 4, 0x112, 0, 0, 0, 0, 0], 48],
  [[0x2620, 0x4f, 0x8000, 0, 0, 0, 0, 0], 48],
  [[0x2001, 0x10, 0, 0, 0, 0, 0, 0], 28],
  [[0x2001, 0x20, 0, 0, 0, 0, 0, 0], 28],
  [[0x2001, 0x30, 0, 0, 0, 0, 0, 0], 28],
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 23],
  [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32],
];

function inRange(parts: ReadonlyArray<number>, [prefix, bits]: Range, partBits: number): boolean {
  let remaining = bits;
  for (let index = 0; remaining > 0; index++, remaining -= partBits) {
    const shift = partBits - Math.min(remaining, partBits);
    if (parts[index] >> shift !== prefix[index] >> shift) {
      return false;
    }
  }
  return true;
}

function parseIpv4(value: string): Array<number> | undefined {
  const parts = value.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) < 256)) {
    return undefined;
  }
  return parts.map(Number);
}

function parseIpv6(value: string): Array<number> | undefined {
  let address = value;
  // URL hosts are already in hex form; a dotted IPv4 tail is accepted for direct callers.
  const dotted = /^(.*:)([^:]+\.[^:]+)$/.exec(address);
  if (dotted) {
    const ipv4 = parseIpv4(dotted[2]);
    if (!ipv4) {
      return undefined;
    }
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    address = `${dotted[1]}${high}:${low}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const parse = (half: string): Array<number> | undefined => {
    if (half === '') {
      return [];
    }
    const groups = half.split(':');
    return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
      ? groups.map((group) => parseInt(group, 16))
      : undefined;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...Array<number>(fill).fill(0), ...tail] : undefined;
}

/**
 * Whether a URL hostname is `localhost`, `*.localhost`, or a literal IPv4 or
 * IPv6 address outside the public unicast space. IPv4-mapped IPv6 addresses
 * are checked as the IPv4 address they carry. Other hostnames return `false`.
 */
export function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    return IPV4_RANGES.some((range) => inRange(ipv4, range, 8));
  }
  if (!host.startsWith('[') || !host.endsWith(']')) {
    return false;
  }
  const ipv6 = parseIpv6(host.slice(1, -1));
  if (!ipv6) {
    return false;
  }
  if (ipv6.slice(0, 5).every((part) => part === 0) && (ipv6[5] === 0xffff || ipv6[5] === 0)) {
    // IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible (`::a.b.c.d`).
    if (ipv6[5] === 0xffff || ipv6[6] !== 0 || ipv6[7] > 1) {
      const embedded = [ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff];
      return IPV4_RANGES.some((range) => inRange(embedded, range, 8));
    }
  }
  return IPV6_RANGES.some((range) => inRange(ipv6, range, 16));
}
