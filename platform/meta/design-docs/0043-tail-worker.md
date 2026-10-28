---
title: User Worker Log Collection
status: implemented
---

# User Worker log collection

A platform Tail Worker receives trace events from user Workers in the
dispatch namespace. It records historical log data in Analytics Engine and
feeds live subscribers through a Durable Object. The API queries historical
events and brokers authorized live access for project operators.

This approach is required because the ordinary Workers Logs query and Tail
REST endpoints do not provide the needed observability for dispatch
namespace user Workers. The separate Tail Worker keeps log collection out
of the request-serving path while preserving per-project authorization at
the API.

The implementation is in [the Tail Worker](../../packages/tail/src/index.ts)
and the public command behavior is in the
[CLI reference](../../../docs/en/reference/cli.md).
