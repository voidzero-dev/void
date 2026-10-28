---
title: WebSocket Routes
status: implemented
---

# WebSocket routes

A .ws.ts route defines a URL-addressable WebSocket endpoint. defineRoom
shares one Durable Object instance among clients in a room; defineWebSocket
handles each connection independently. The framework compiles route
metadata, validates the server definition, and wires the Durable Object
binding and migrations for Cloudflare deployment.

The client helper supports typed connection and reconnection behavior.
WebSocket routes are Cloudflare-targeted because the coordination model
depends on Durable Objects; Node.js, Bun, and Deno builds reject these
routes. See the [WebSockets guide](../../../docs/en/guide/websockets.md) for
the supported API and lifecycle.
