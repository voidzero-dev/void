// Requests whose response depends on auth, including parent requests after a rewrite.
export const authDependentRequests: WeakSet<Request> = new WeakSet();

// Targeted policies a CDN can follow ahead of Cache-Control.
export const SHARED_CACHE_HEADERS: ReadonlyArray<string> = [
  'cdn-cache-control',
  'cloudflare-cdn-cache-control',
  'surrogate-control',
];
