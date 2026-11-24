import type { CfCustomerClient, CfCustomerZone } from './cf-customer.ts';

/** Look up public MX exchange names, without priority and trailing dot. */
export async function lookupMxOverDns(domain: string): Promise<ReadonlyArray<string>> {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
    { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`public DNS MX lookup failed with HTTP ${response.status}`);
  }
  const json = await response.json<{
    Status: number;
    TC?: boolean;
    Answer?: ReadonlyArray<{ type: number; data: string }>;
  }>();
  if ((json.Status !== 0 && json.Status !== 3) || json.TC) {
    throw new Error('public DNS MX lookup did not return a complete answer');
  }
  return (json.Answer ?? [])
    .filter((answer) => answer.type === 15)
    .map((answer) => answer.data.trim().split(/\s+/).slice(1).join(' ').replace(/\.$/, ''));
}

/** Confirm Cloudflare Email Sending onboarded the exact domain. */
export async function sendingOnboardedReadback(
  client: CfCustomerClient,
  zoneId: string,
  domain: string,
): Promise<boolean> {
  const subdomains = await client.listSendingSubdomains(zoneId);
  return subdomains.some(
    (subdomain) => subdomain.enabled && subdomain.name.toLowerCase() === domain.toLowerCase(),
  );
}

/** Find the deepest visible Cloudflare zone containing a domain. */
export async function findZoneForEmailDomain(
  client: CfCustomerClient,
  domain: string,
): Promise<CfCustomerZone | null> {
  const labels = domain.split('.');
  for (let start = 0; start <= labels.length - 2; start++) {
    const zone = await client.findZone(labels.slice(start).join('.'));
    if (zone) {
      return zone;
    }
  }
  return null;
}
