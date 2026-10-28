---
title: Named Page Actions
status: implemented
---

# Named page actions

A Pages route can export several named mutation handlers instead of one
default action. A request identifies the handler by the action name in the
query string; a bare mutation uses actions.default when present. Unknown
names fail without invoking another action.

Named actions share the page loader, validation, rendering, and client
navigation protocol with the original single-action route. Generated
route types and form helpers preserve the selected action's input and
result types. The public syntax and behavior are in the
[actions guide](../../../docs/en/guide/pages-routing/actions-and-forms.md).
