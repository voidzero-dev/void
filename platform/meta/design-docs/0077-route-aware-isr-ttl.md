---
title: Route-Aware ISR TTL Resolution
status: implemented
created: 2026-07-10
---

# Route-aware ISR TTL resolution

A flat map of patterns to TTLs loses pages that have no TTL. A catch-all such
as `/docs/*` can then cache a more-specific page that never opted into ISR.
The cache must resolve the same winning route as the application before
choosing its policy.

This refines the original [ISR](./0008-isr.md) and
[prerendering](./0020-prerender.md) designs. Current behavior is described in
the [revalidation guide](../../../docs/en/guide/edge/revalidation.md).

## Ordered page table

Void Pages builds emit every page in the router's authoritative match order,
including pages without `revalidate`. Platform validation and routing
serialization preserve that order. Consumers must not invent another
specificity ranking.

The shared [`resolvePageTtl`](../../../packages/isr/src/core.ts) applies the
winning page's policy:

- A positive page TTL enables ISR; an explicit zero opts out.
- A page with no explicit TTL consults the raw per-path configuration.
- A path that matches no page, or a legacy manifest without a page table,
  falls back to the flattened revalidation configuration.

Keep raw user configuration separate from the flattened map containing other
pages' TTLs. Otherwise a specific page can accidentally inherit its sibling
catch-all's policy. The API prewarm path, direct runtime and platform dispatch
use the shared resolver so writes and reads agree.

## Cache eligibility

Route policy alone does not authorize shared caching. API paths and asset
paths must bypass page ISR. Authentication, dynamic rendering, cookies,
response cache opt-outs and the shared page-cache policy also constrain reads
and writes. Do not repair only the write path: an earlier cached response can
be served before the application runs.

## Compatibility and verification

The ordered page table is an additive manifest field. Keep the flat map for
legacy consumers and non-page patterns. Absence is valid; malformed supplied
entries are rejected.

Regression coverage must include a specific page without a TTL below a
catch-all with a TTL, explicit zero, raw path-config inheritance, a path with
no page, legacy manifests, and API paths under a root catch-all. Verify
producer order, platform pass-through, prewarming and request-time behavior
together.

A TTL-zero exclusion list was rejected because it obscures general route
precedence. An application response header alone cannot fix cache reads that
happen before rendering. The full ordered page table preserves the information
every consumer needs without duplicating the router.
