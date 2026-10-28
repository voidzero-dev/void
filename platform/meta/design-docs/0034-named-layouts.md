---
title: Named Page Layouts
status: implemented
---

# Named page layouts

Pages inherit the default layout chain from their directory hierarchy.
A page can select a named layout stored under _layouts; the nearest matching
ancestor wins. Selection can replace the innermost layout or the full chain,
giving a page a distinct shell without duplicating its route tree.

Layout resolution happens during page scanning and is shared by the framework
adapters. A missing named layout is a build error, which prevents a deployment
from silently rendering without its selected wrapper. See the
[layouts guide](../../../docs/en/guide/pages-routing/layouts.md) for syntax
and inheritance behavior.
