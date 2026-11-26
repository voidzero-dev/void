// Lightweight stub for cloudflare:workers — only available in the Workers runtime.
// Used by vitest alias so modules importing DurableObject can be loaded in tests.
// Like the real base classes, both keep the ctx and env they are built with.
export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

// @cloudflare/containers' Container extends DurableObject and ContainerProxy
// extends WorkerEntrypoint, both imported from cloudflare:workers. build-manager.ts
// (BuildManager extends Container) is re-exported by src/index.ts, so every
// integration test that imports index.ts loads this stub — it must provide both
// base classes or the class-definition `extends` evaluates to undefined and throws.
export class WorkerEntrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}
