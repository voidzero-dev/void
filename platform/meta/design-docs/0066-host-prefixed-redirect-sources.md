---
title: Host-Prefixed Sources for Redirects and Rewrites
status: implemented
created: 2026-04-22
---

# Host-prefixed sources for redirects and rewrites

A redirect or rewrite source may start with a literal HTTPS hostname. This
lets one project route different bound domains differently, including a
canonical-host redirect. A source without a hostname continues to apply to
every domain bound to the project.

The framework parser separates the optional hostname from the path pattern.
The deploy manifest carries the normalized hostname in the rule's optional
`host` field. Dispatch checks it against the request host before matching the
path. Source-host matching and the destination URL are independent, so a rule
can redirect an old bound domain to another domain.

The source host must be a literal hostname bound to the project. Wildcards,
ports, userinfo, and protocol-relative or HTTP sources are rejected. A pending
custom domain may appear in a rule; the rule stays inert until that domain
becomes active. Restricting rules to bound hosts catches misspellings at deploy
time and keeps the wire format independent of an arbitrary request header
expression language.

Rules from `void.json` precede rules in a file-based `_redirects` list in the
same routing phase, and the first matching rule wins. See the
[redirects guide](../../../docs/en/guide/edge/redirects.md) for syntax and
validation details.
