import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import mysql from 'mysql2';

/** The parts of mysql2's server-side connection that the fake server uses. */
type ServerConnection = {
  sequenceId: number;
  serverHandshake(options: Record<string, unknown>): void;
  on(event: 'query', listener: (sql: string) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  writeColumns(columns: Array<Record<string, unknown>>): void;
  writeTextRow(values: Array<unknown>): void;
  writeEof(): void;
  writeOk(packet?: { affectedRows?: number }): void;
};

const { Connection, ConnectionConfig } = mysql as unknown as {
  Connection: new (options: { config: unknown }) => ServerConnection;
  ConnectionConfig: new (options: { stream: Socket; isServer: true }) => unknown;
};

const CHARSET = mysql.Charsets.UTF8_GENERAL_CI;
// Every basic capability except CLIENT_SSL (0x0800), so clients never ask for TLS.
const CAPABILITY_FLAGS = 0xff_ff & ~0x08_00;

export type FakeMySqlRow = Record<string, number | string | null>;

export type FakeMySqlServer = {
  port: number;
  /** The client connections the server holds open. */
  openConnections(): number;
  /** Every client connection the server has accepted. */
  acceptedConnections(): number;
  close(): Promise<void>;
};

function columnsOf(rows: Array<FakeMySqlRow>) {
  return Object.keys(rows[0] ?? {}).map((name) => ({
    catalog: 'def',
    schema: 'app',
    table: 'fake',
    orgTable: 'fake',
    name,
    orgName: name,
    characterSet: CHARSET,
    columnLength: 255,
    columnType: typeof rows[0]?.[name] === 'number' ? mysql.Types.LONG : mysql.Types.VAR_STRING,
    flags: 0,
    decimals: 0,
  }));
}

/**
 * A MySQL wire-protocol server built on mysql2's own server API. It accepts any user, answers
 * every SELECT with `rows`, or with what `rows` returns for the query (columns in key order of
 * the first row), and every other statement with OK for one row. It speaks the text protocol
 * only, which is what drizzle's mysql2 driver uses.
 */
export async function startFakeMySqlServer(
  rows: Array<FakeMySqlRow> | ((sql: string) => Array<FakeMySqlRow>),
): Promise<FakeMySqlServer> {
  const sockets = new Set<Socket>();
  let accepted = 0;

  const server = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const connection = new Connection({
      config: new ConnectionConfig({ stream: socket, isServer: true }),
    });
    connection.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.4.0-void-test',
      connectionId: 1,
      statusFlags: 2,
      characterSet: CHARSET,
      capabilityFlags: CAPABILITY_FLAGS,
      authCallback(_params: unknown, done: (error: null) => void) {
        done(null);
        // Each command starts a new packet sequence; the server API leaves the reset to us.
        connection.sequenceId = 0;
      },
    });
    connection.on('query', (sql) => {
      if (/^\s*select\b/i.test(sql)) {
        const answer = typeof rows === 'function' ? rows(sql) : rows;
        const columns = columnsOf(answer);
        connection.writeColumns(columns);
        for (const row of answer) {
          connection.writeTextRow(columns.map((column) => row[column.name]));
        }
        connection.writeEof();
      } else {
        connection.writeOk({ affectedRows: 1 });
      }
      connection.sequenceId = 0;
    });
    // A client that drops its socket emits an error here; unhandled, it would end the test run.
    connection.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    port: (server.address() as AddressInfo).port,
    openConnections: () => sockets.size,
    acceptedConnections: () => accepted,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await once(server, 'close');
    },
  };
}
