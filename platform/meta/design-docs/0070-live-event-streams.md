---
title: Live Event Streams
status: implemented
---

# Live event streams

void/live delivers topic events from routes, scheduled jobs, and queue consumers to browser subscribers over Server-Sent Events. A generated Durable Object hub tracks connections and topic subscriptions; the browser client multiplexes several subscriptions over one EventSource and restores active subscriptions after reconnecting.

Applications define a stream, expose its connect and control handlers, and publish by topic. Authorization, replay behavior, and delivery limits are described in the [live streams guide](../../../docs/en/guide/live.md).

See [server runtime](../../../packages/void/src/runtime/live.ts), [hub implementation](../../../packages/void/src/runtime/live-server.ts), and [browser client](../../../packages/void/src/runtime/live-client.ts).
