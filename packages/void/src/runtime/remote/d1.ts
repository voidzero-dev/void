import type { ProxyClient } from './client.ts';

type ProxyPreparedStatement = D1PreparedStatement & {
  _sql: string;
  readonly _params: Array<unknown>;
};

/**
 * D1Database implementation backed by the remote proxy.
 * Used during local development when `remote: true` is set in void.config.ts.
 */
export class ProxyD1Database {
  constructor(
    private client: ProxyClient,
    private binding: string,
  ) {}

  prepare(sql: string): ProxyD1PreparedStatement {
    return new ProxyD1PreparedStatement(this.client, this.binding, sql);
  }

  async batch<T = unknown>(stmts: Array<D1PreparedStatement>): Promise<Array<D1Result<T>>> {
    const statements = stmts.map((s) => ({
      sql: (s as ProxyPreparedStatement)._sql,
      params: (s as ProxyPreparedStatement)._params,
    }));
    const res = await this.client.fetch('/d1/batch', {
      binding: this.binding,
      statements,
    });
    return await res.json<Array<D1Result<T>>>();
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const res = await this.client.fetch('/d1/query', {
      binding: this.binding,
      sql,
      method: 'run',
    });
    const data = await res.json<{ meta?: { changes?: number; duration?: number } }>();
    return {
      count: data.meta?.changes ?? 0,
      duration: data.meta?.duration ?? 0,
    };
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported with remote bindings');
  }

  // Each statement is a separate proxy call that the platform runs on the
  // deployed binding without a session, so there is no replica or bookmark
  // state to carry. The proxy itself serves as the session.
  withSession(_constraintOrBookmark?: string): ProxyD1Database {
    return this;
  }

  getBookmark(): string | null {
    return null;
  }
}

/**
 * D1PreparedStatement implementation backed by the remote proxy.
 * Accumulates SQL and params synchronously; terminal methods (all, first, run, raw) make the HTTP call.
 */
export class ProxyD1PreparedStatement {
  /** @internal */
  readonly _sql: string;
  /** @internal */
  _params: Array<unknown>;

  constructor(
    private client: ProxyClient,
    private binding: string,
    sql: string,
    params: Array<unknown> = [],
  ) {
    this._sql = sql;
    this._params = params;
  }

  private query(method: 'all' | 'first' | 'run' | 'raw'): Promise<Response> {
    return this.client.fetch('/d1/query', {
      binding: this.binding,
      sql: this._sql,
      params: this._params,
      method,
    });
  }

  bind(...values: Array<unknown>): ProxyD1PreparedStatement {
    return new ProxyD1PreparedStatement(this.client, this.binding, this._sql, values);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const res = await this.query('all');
    return await res.json<D1Result<T>>();
  }

  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = unknown>(col: string): Promise<T | null>;
  async first<T = unknown>(col?: string): Promise<T | null> {
    const res = await this.query('first');
    const row = await res.json<Record<string, unknown> | null>();
    if (row === null) {
      return null;
    }
    if (col) {
      return row[col] as T;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const res = await this.query('run');
    return await res.json<D1Result<T>>();
  }

  async raw<T = Array<unknown>>(options?: { columnNames?: boolean }): Promise<Array<T>> {
    const res = await this.query('raw');
    const data = await res.json<{
      columns: Array<string>;
      results: Array<Array<unknown>>;
    }>();
    if (options?.columnNames) {
      return [data.columns, ...data.results] as Array<T>;
    }
    return data.results as Array<T>;
  }
}
