---
title: Markdown Pages
status: implemented
---

# Markdown pages

Markdown files participate in Pages routing. The markdown adapter compiles
body content, reads frontmatter for page metadata, and renders through the
same layout and head pipeline as other Pages routes. Island imports can make
selected components interactive without turning the whole markdown page
into a client application.

A script block may also supply page-specific client code. The build splits
that code per page, so a markdown page without client behavior does not
carry another page's script. The source of truth for the public syntax is the
[markdown guide](../../../docs/en/guide/pages-routing/markdown.md).
