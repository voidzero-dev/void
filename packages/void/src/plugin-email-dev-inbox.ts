import { timingSafeEqual } from 'node:crypto';
// Dev-only Vite plugin: owns the in-memory email buffer and serves
// `/__void/inbox` routes for browsing captured messages. Activated when
// binding inference detected `void/email` usage.
//
// `sendEmail` runs in workerd, a separate OS process, so it POSTs each
// captured message to `/__void/inbox/_capture` through its dev assets
// binding, which @cloudflare/vite-plugin wires into this middleware stack.
//
// Every route requires the project's dev-trigger token — the same one
// `/__void/scheduled` and `/__void/queue` check. Vite's own host validation
// only rejects DNS-rebinding hostnames: any IP-literal `Host` passes, so with
// `--host` (or a shared port) every peer on the network could otherwise read
// raw MIME (Bcc, attachments), clear the buffer, or plant captures.
import type { Plugin } from 'vite';
import { Buffer } from './cli/node-buffer.ts';
import { voidLog } from './log.ts';
import { afterServerReady } from './plugin-dev-config.ts';
import {
  clearDevBuffer,
  DEV_INBOX_ACK_HEADER,
  DEV_INBOX_ACK_VALUE,
  DEV_INBOX_CAPTURE_PATH,
  DEV_INBOX_MAX_CAPTURE_BYTES,
  DEV_INBOX_PREFIX,
  DEV_INBOX_TOKEN_HEADER,
  DEV_INBOX_TOKEN_QUERY,
  findDevMessage,
  listDevMessages,
  parseCapturedMessage,
  pushToDevBuffer,
} from './runtime/email/dev-inbox.ts';
import type { CapturedMessage } from './runtime/email/dev-inbox.ts';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // The detail page already escapes HTML and renders the email body inside a
  // sandboxed iframe (no allow-scripts). CSP enforces it for everything else.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-src data:; img-src data:; connect-src 'none'",
} as const;

export interface EmailDevInboxPluginOptions {
  /**
   * The per-project dev-trigger token (`.void/dev-trigger-token`), shared with
   * the cron/queue dev routes and injected into the worker as
   * `__VOID_EMAIL_DEV_INBOX_TOKEN` so its capture POST can present it.
   */
  devTriggerToken: string;
}

export function emailDevInboxPlugin(options: EmailDevInboxPluginOptions): Plugin {
  const { devTriggerToken } = options;

  /** `href` for an inbox path that keeps the browser session authorized. */
  const inboxHref = (path: string): string =>
    `${DEV_INBOX_PREFIX}${path}?${DEV_INBOX_TOKEN_QUERY}=${encodeURIComponent(devTriggerToken)}`;

  return {
    name: 'void:email-dev-inbox',
    apply: 'serve',
    configureServer(server) {
      // The browser cannot add a header, so the inbox URL is printed with the
      // token in its query, the same way the cron/queue hint prints its curl.
      const printInboxUrl = () => {
        const address = server.httpServer?.address();
        const port = typeof address === 'object' && address ? address.port : null;
        if (port === null || port === undefined) {
          return;
        }
        voidLog(`Email inbox: http://localhost:${port}${inboxHref('')}`);
      };
      afterServerReady(server, printInboxUrl);

      server.middlewares.use(DEV_INBOX_PREFIX, (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (!isAuthorized(req.headers[DEV_INBOX_TOKEN_HEADER], url, devTriggerToken)) {
          // No ack header here: the worker must not read a refusal as a capture.
          res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(
            `Unauthorized: the void dev inbox requires the dev-trigger token — send it as the ${DEV_INBOX_TOKEN_HEADER} header or the ?${DEV_INBOX_TOKEN_QUERY}= query (printed as the inbox URL when void dev starts; stored in .void/dev-trigger-token).`,
          );
          return;
        }

        if (req.method === 'POST' && path === DEV_INBOX_CAPTURE_PATH) {
          void handleCapture(req, res);
          return;
        }
        if (req.method === 'DELETE' && path === '/') {
          clearDevBuffer();
          res.writeHead(204, SECURITY_HEADERS);
          res.end();
          return;
        }
        if (req.method !== 'GET') {
          res.writeHead(405, SECURITY_HEADERS);
          res.end();
          return;
        }

        if (path === '/' || path === '') {
          res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderListHtml(listDevMessages(), inboxHref));
          return;
        }
        const match = path.match(/^\/([^/]+)(\/raw)?$/);
        if (!match) {
          res.writeHead(404, SECURITY_HEADERS);
          res.end();
          return;
        }
        const id = match[1];
        const wantsRaw = Boolean(match[2]);
        const message = findDevMessage(id);
        if (!message) {
          res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
          res.end('Email not found.');
          return;
        }
        if (wantsRaw) {
          // The id arrives in the capture payload; strip quotes and line
          // breaks before it goes into a header value.
          const safeId = id.replaceAll(/["\r\n]/g, '');
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'message/rfc822',
            'Content-Disposition': `attachment; filename="${safeId}.eml"`,
          });
          res.end(Buffer.from(message.raw));
          return;
        }
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDetailHtml(message, inboxHref));
      });
    },
  };
}

/**
 * Constant-time check of the presented token — header first (worker, curl),
 * then the query (browser). Both are compared against the one project token.
 */
function isAuthorized(
  headerValue: string | Array<string> | undefined,
  url: URL,
  expected: string,
): boolean {
  const presented =
    typeof headerValue === 'string' ? headerValue : url.searchParams.get(DEV_INBOX_TOKEN_QUERY);
  if (typeof presented !== 'string') {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

// Structural shapes rather than `node:http` classes: the same handler is
// exercised in unit tests against a synthesized req/res pair.
interface CaptureRequest extends AsyncIterable<Uint8Array | string> {
  headers: Record<string, string | Array<string> | undefined>;
}
interface CaptureResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(chunk?: string | Buffer): unknown;
}

/**
 * `POST /__void/inbox/_capture` — the worker's dev-inbox hop.
 *
 * Fails with a status the worker can distinguish, and only a success carries
 * the ack header, so the worker never mistakes an ordinary asset 200 for a
 * capture. Never throws: an exception here would surface as a dev-server 500
 * in the middle of the user's `sendEmail`.
 */
async function handleCapture(req: CaptureRequest, res: CaptureResponse): Promise<void> {
  try {
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.includes('application/json')) {
      res.writeHead(415, SECURITY_HEADERS);
      res.end();
      return;
    }
    const chunks: Array<Buffer> = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buf.byteLength;
      if (size > DEV_INBOX_MAX_CAPTURE_BYTES) {
        res.writeHead(413, SECURITY_HEADERS);
        res.end();
        return;
      }
      chunks.push(buf);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, SECURITY_HEADERS);
      res.end();
      return;
    }
    const message = parseCapturedMessage(parsed);
    if (!message) {
      res.writeHead(400, SECURITY_HEADERS);
      res.end();
      return;
    }
    pushToDevBuffer(message);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      [DEV_INBOX_ACK_HEADER]: DEV_INBOX_ACK_VALUE,
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true, id: message.id }));
  } catch {
    res.writeHead(500, SECURITY_HEADERS);
    res.end();
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatAddress(a: { email: string; name?: string }): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; max-width: 1024px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  h2 { font-size: 14px; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
  th { font-weight: 600; opacity: 0.7; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  a { color: #5b8def; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .meta { font-size: 12px; opacity: 0.7; }
  .empty { padding: 48px; text-align: center; opacity: 0.6; }
  .row { display: flex; gap: 12px; align-items: baseline; }
  .row .subject { font-weight: 600; }
  iframe { width: 100%; min-height: 480px; border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 8px; background: white; }
  .actions { display: flex; gap: 12px; margin-bottom: 16px; }
  .button { display: inline-block; padding: 6px 12px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 6px; cursor: pointer; background: transparent; color: inherit; font: inherit; }
  pre { white-space: pre-wrap; word-break: break-word; padding: 12px; background: color-mix(in srgb, currentColor 5%, transparent); border-radius: 6px; }
  .header-table th { width: 160px; }
`;

function renderListHtml(messages: Array<CapturedMessage>, href: (path: string) => string): string {
  const rows = messages
    .map(
      (m) => `
        <tr>
          <td><a href="${escapeHtml(href(`/${m.id}`))}">${escapeHtml(m.subject || '(no subject)')}</a></td>
          <td>${escapeHtml(formatAddress(m.from))}</td>
          <td>${escapeHtml(m.to.map(formatAddress).join(', '))}</td>
          <td class="meta">${escapeHtml(formatTime(m.capturedAt))}</td>
          <td class="meta"><a href="${escapeHtml(href(`/${m.id}/raw`))}">.eml</a></td>
        </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Void — Email inbox</title><style>${STYLE}</style></head>
<body>
  <h1>Email inbox <span class="meta">(${messages.length} message${messages.length === 1 ? '' : 's'})</span></h1>
  ${
    messages.length === 0
      ? `<div class="empty">No messages captured yet. Call <code>sendEmail()</code> from your app to populate.</div>`
      : `<table>
            <thead><tr><th>Subject</th><th>From</th><th>To</th><th>Captured</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
  }
</body></html>`;
}

function renderDetailHtml(m: CapturedMessage, href: (path: string) => string): string {
  const headerRows = Object.entries(m.headers)
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  const attachmentRows = m.attachments
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.filename)}</td><td>${escapeHtml(a.contentType)}</td><td>${a.size} B</td><td>${a.disposition}</td></tr>`,
    )
    .join('');
  const bodyHtml = m.html
    ? `<iframe sandbox srcdoc="${escapeHtml(m.html)}"></iframe>`
    : `<pre>${escapeHtml(m.text ?? '')}</pre>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(m.subject || '(no subject)')} — Void inbox</title><style>${STYLE}</style></head>
<body>
  <div class="actions">
    <a class="button" href="${escapeHtml(href(''))}">← Back</a>
    <a class="button" href="${escapeHtml(href(`/${m.id}/raw`))}">Download .eml</a>
  </div>
  <h1>${escapeHtml(m.subject || '(no subject)')}</h1>
  <table class="header-table">
    <tr><th>From</th><td>${escapeHtml(formatAddress(m.from))}</td></tr>
    <tr><th>To</th><td>${escapeHtml(m.to.map(formatAddress).join(', '))}</td></tr>
    ${m.cc.length > 0 ? `<tr><th>Cc</th><td>${escapeHtml(m.cc.map(formatAddress).join(', '))}</td></tr>` : ''}
    ${m.bcc.length > 0 ? `<tr><th>Bcc</th><td>${escapeHtml(m.bcc.map(formatAddress).join(', '))}</td></tr>` : ''}
    ${m.replyTo ? `<tr><th>Reply-To</th><td>${escapeHtml(formatAddress(m.replyTo))}</td></tr>` : ''}
    <tr><th>Captured</th><td class="meta">${escapeHtml(formatTime(m.capturedAt))}</td></tr>
    <tr><th>Message-ID</th><td class="meta">${escapeHtml(m.messageId)}</td></tr>
  </table>
  ${headerRows ? `<h2>Custom headers</h2><table class="header-table">${headerRows}</table>` : ''}
  ${
    attachmentRows
      ? `<h2>Attachments</h2><table><thead><tr><th>Filename</th><th>Type</th><th>Size</th><th>Disposition</th></tr></thead><tbody>${attachmentRows}</tbody></table>`
      : ''
  }
  <h2>Body</h2>
  ${bodyHtml}
</body></html>`;
}
