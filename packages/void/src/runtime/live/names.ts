import { bytesToBase64 } from './base64.ts';

export async function topicDigest(streamId: string, topic: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${streamId}\u0000${topic}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToBase64(new Uint8Array(digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function connectionInstanceName(streamId: string, connectionId: string): string {
  return `live:${streamId}:connection:${connectionId}`;
}

export function topicInstanceName(streamId: string, topicKey: string): string {
  return `live:${streamId}:topic:${topicKey}`;
}

export function internalUrl(path: string): string {
  return `https://void.live${path}`;
}
