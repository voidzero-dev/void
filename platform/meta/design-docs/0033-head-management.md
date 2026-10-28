---
title: Page Head Management
status: implemented
---

# Page head management

Pages can contribute head content through a page head export. Configuration
and middleware supply shared defaults, while the page supplies route-specific
title, metadata, links, and scripts. The rendering pipeline merges these
sources before producing HTML and updates the head during client navigation.

Markdown frontmatter feeds the same head model. This keeps one merge and
rendering contract across regular Pages, islands, markdown, and static
output rather than leaving each mode to build its own head tags. See the
[head guide](../../../docs/en/guide/pages-routing/head.md) for precedence and
supported descriptors.
