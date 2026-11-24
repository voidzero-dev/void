import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Plugin } from 'vite';
import { safeJsonStringify } from './pages/protocol.ts';

const BINDING_HINT_VIRTUAL = 'virtual:void/binding-hint';
const BINDING_HINT_RESOLVED = '\0' + BINDING_HINT_VIRTUAL;

const RESTARTING_HTML_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Restarting</title>
  <style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1a1a2e;color:#e0def4;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
    .tag{color:#c4a7e7;font-weight:700}
    @keyframes d{0%,80%{opacity:0}40%{opacity:1}}
    .dots span{opacity:0;animation:d 1.4s infinite}
    .dots span:nth-child(2){animation-delay:.2s}
    .dots span:nth-child(3){animation-delay:.4s}
  </style>
</head>
<body>
  <div><span class="tag">[void]</span> Restarting dev server<span class="dots"><span>.</span><span>.</span><span>.</span></span></div>
  <script>
    var target=`;

const RESTARTING_HTML_MIDDLE = `;
    var token=`;

const RESTARTING_HTML_TAIL = `;
    fetch("/__void/restart",{method:"POST",headers:{"x-void-restart":token}}).catch(function(){});
    setTimeout(function p(){
      fetch("/__void/ping").then(function(r){
        if(r.ok)location.href=target;
        else setTimeout(p,150);
      }).catch(function(){setTimeout(p,150)});
    },300);
  </script>
</body>
</html>`;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Returns `value` when it is a path on the dev server's own origin, else `/`.
 * The restarting page navigates to it, so a scheme (`javascript:`) or a
 * protocol-relative form (`//host`, `/\host`) must never get through.
 */
export function sanitizeReturnPath(value: string | null | undefined): string {
  if (!value || value[0] !== '/' || value[1] === '/' || value[1] === '\\') {
    return '/';
  }
  if (CONTROL_CHARS.test(value)) {
    return '/';
  }
  const base = 'http://void.invalid';
  try {
    if (new URL(value, base).origin !== base) {
      return '/';
    }
  } catch {
    return '/';
  }
  return value;
}

/** Header the restarting page sends the per-server restart token in. */
export const RESTART_TOKEN_HEADER = 'x-void-restart';

/**
 * `token` is the `t` query value the toast navigated with. The page sends it
 * back with its POST; `/__void/restart` checks it, not this page.
 */
export function renderRestartingPage(
  returnPath: string | null | undefined,
  token: string | null | undefined,
): string {
  return (
    RESTARTING_HTML_HEAD +
    safeJsonStringify(sanitizeReturnPath(returnPath)) +
    RESTARTING_HTML_MIDDLE +
    safeJsonStringify(token ?? '') +
    RESTARTING_HTML_TAIL
  );
}

/** Whether `presented` is this server's restart token, compared in constant time. */
export function isRestartTokenValid(
  presented: string | Array<string> | undefined,
  expected: string,
): boolean {
  if (typeof presented !== 'string' || expected.length === 0) {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/**
 * Whether a browser sent `req` from the dev server's own origin. Any page the
 * developer visits can POST to localhost, so cross-site callers are refused.
 * `Sec-Fetch-Site` is set by the browser and cannot be forged by a page;
 * `Origin` is the fallback for browsers that do not send it. Clients that send
 * neither (curl, scripts) are not browsers acting for another site.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) {
    return site === 'same-origin';
  }
  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  const host = req.headers.host;
  if (!host) {
    return false;
  }
  const scheme = (req.socket as TLSSocket | undefined)?.encrypted ? 'https' : 'http';
  return origin === `${scheme}://${host}`;
}

/** Whether a browser navigated here from the dev origin itself or from the address bar. */
export function isSameOriginNavigation(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

/**
 * The toast is the only in-app way to reach `/__void/restarting`, so it is
 * the only place that knows the restart token. Vite's default `server.cors`
 * lets only localhost origins read this module, the same exposure as the
 * HMR token in `/@vite/client`.
 */
const clientModule = (token: string): string => `if (import.meta.hot) {
  const token = ${JSON.stringify(token)};
  import.meta.hot.on("void:new-binding", (d) => {
    if (document.getElementById("void-binding-hint")) return;
    const e = document.createElement("div");
    e.id = "void-binding-hint";
    e.style.cssText = "position:fixed;top:16px;right:16px;z-index:99999;padding:12px 16px;background:rgba(26,26,46,0.95);color:#e0def4;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;border-radius:8px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 32px rgba(0,0,0,0.4);backdrop-filter:blur(8px);cursor:pointer;max-width:300px;transform:translateX(calc(100% + 16px));transition:transform .3s ease";
    e.innerHTML = "<strong style=\\"color:#c4a7e7\\">[void]</strong> " + d.message + " Click to restart.";
    e.onclick = () => { location.href = "/__void/restarting?return=" + encodeURIComponent(location.pathname + location.search) + "&t=" + encodeURIComponent(token); };
    document.body.appendChild(e);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      e.style.transform = "translateX(0)";
    }));
  });
}`;

/**
 * Vite plugin that provides controlled dev-server restart via the browser.
 *
 * Serves three endpoints:
 * - `/__void/restarting` — standalone loading page (no Vite HMR client);
 *                          same-origin navigation only
 * - `/__void/restart`    — same-origin POST carrying this server's restart
 *                          token triggers `server.restart()` after a short delay
 * - `/__void/ping`       — health check; returns 503 on the old server instance
 *                          (after restart is triggered) and 200 on the new one
 *
 * Also injects a virtual module (`virtual:void/binding-hint`) that listens for
 * `void:new-binding` HMR events and shows a toast with a click-to-restart action.
 */
export function restartPlugin(): Plugin {
  // Browsers omit Fetch Metadata for plain-HTTP non-localhost origins
  // (`void dev --host` on a LAN IP), so the navigation check alone lets any
  // page open `/__void/restarting`, whose POST then carries our own Origin.
  // The token proves the navigation came from the toast. Each server instance
  // (including the one `server.restart()` creates) gets a fresh one.
  let restartToken = '';
  return {
    name: 'void:restart',
    apply: 'serve',

    resolveId: {
      filter: { id: /^virtual:void\/binding-hint$/ },
      handler() {
        return BINDING_HINT_RESOLVED;
      },
    },

    load: {
      // Vite virtual module null-byte prefix
      filter: { id: /^\0virtual:void\/binding-hint$/ },
      handler() {
        return clientModule(restartToken);
      },
    },

    configureServer(server) {
      let restartPending = false;
      // This instance checks its own token; `load` serves the latest one.
      const token = randomBytes(16).toString('base64url');
      restartToken = token;

      server.middlewares.use('/__void/ping', (_req, res) => {
        res.writeHead(restartPending ? 503 : 200);
        res.end();
      });

      server.middlewares.use('/__void/restart', (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (
          !isSameOriginRequest(req) ||
          !isRestartTokenValid(req.headers[RESTART_TOKEN_HEADER], token)
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        restartPending = true;
        res.writeHead(200);
        res.end();
        setTimeout(() => server.restart(), 50);
      });

      server.middlewares.use('/__void/restarting', (req, res) => {
        if (!isSameOriginNavigation(req)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Restart the dev server from its own page.');
          return;
        }
        let returnPath: string | null = null;
        let presented: string | null = null;
        try {
          const params = new URL(req.url ?? '/', 'http://void.invalid').searchParams;
          returnPath = params.get('return');
          presented = params.get('t');
        } catch {
          // A request url that does not parse returns to `/` without restarting.
        }
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(renderRestartingPage(returnPath, presented));
      });
    },
  };
}
