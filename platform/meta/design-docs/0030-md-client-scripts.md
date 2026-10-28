---
title: Markdown Client Scripts
status: implemented
---

# Markdown client scripts

The markdown compiler extracts a page's script block before compiling the
body. Island imports are handled by the island pipeline; remaining browser
code becomes a page-specific client module. The build loads that module only
for the page that declared it, and pages without client code add no such
chunk.

This preserves markdown as a content-first format while allowing local
interaction without a shared bundle for every markdown route. The compiler
lives in [the markdown plugin](../../../packages/md/src/plugin.ts); the
public syntax is in the
[markdown guide](../../../docs/en/guide/pages-routing/markdown.md).
