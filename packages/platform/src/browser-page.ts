/** Shared, dependency-free presentation for browser onboarding and authentication pages. */
export const browserPageLogo: string =
  '<svg role="img" aria-label="Void" viewBox="0 0 270 58" fill="none" xmlns="http://www.w3.org/2000/svg">\n<circle cx="262" cy="48.96" r="8" fill="currentColor"/>\n<path d="M20.72 0.959999L35.52 41.28L50.08 0.959999H70L47.92 56.96H22.32L0.24 0.959999H20.72ZM106.542 57.92C82.9419 57.92 70.6219 48 70.6219 28.96C70.6219 9.92 82.9419 1.90735e-06 106.542 1.90735e-06C130.142 1.90735e-06 142.542 9.92 142.542 28.96C142.542 48 130.142 57.92 106.542 57.92ZM106.542 44.08C117.662 44.08 122.862 39.36 122.862 28.96C122.862 18.48 117.662 13.76 106.542 13.76C95.4219 13.76 90.2219 18.48 90.2219 28.96C90.2219 39.36 95.4219 44.08 106.542 44.08ZM152.265 56.96V0.959999H171.465V56.96H152.265ZM184.687 56.96V0.959999H219.887C239.327 0.959999 250.447 9.84 250.447 28.96C250.447 48.16 239.247 56.96 219.807 56.96H184.687ZM230.767 28.96C230.767 18.48 226.287 14.56 217.167 14.56H203.887V43.36H217.167C226.287 43.36 230.767 39.44 230.767 28.96Z" fill="currentColor"/>\n</svg>';

// Scoped so dashboard and admin application styles remain independent of these pages.
export const browserPageStyles: string = `
:root { color-scheme: light dark; }
html[data-theme="light"] { color-scheme: light; }
html[data-theme="dark"] { color-scheme: dark; }
.void-auth-page {
  --auth-radius-inner: .375rem; --auth-radius-element: .625rem; --auth-radius-container: .75rem;
  --auth-body: light-dark(#f1f1f1, #1b1b1b); --auth-card: light-dark(#fff, #1b1b1b);
  --auth-text: light-dark(#000, #fff); --auth-secondary: light-dark(#474747, #9e9e9e);
  --auth-border: light-dark(#0000000f, #ffffff1a); --auth-accent: light-dark(#1b1b1b, #f1f1f1); --auth-on-accent: light-dark(#fff, #1b1b1b);
  --auth-success: light-dark(#176e45, #79dba9); --auth-success-bg: light-dark(#e7f4ec, #173a29);
  --auth-error: light-dark(#b42332, #ff9aab); --auth-error-bg: light-dark(#fcebed, #421d26);
  box-sizing: border-box; min-height: 100svh; margin: 0;
  padding: clamp(40px, 10vh, 100px) 16px 48px; background: var(--auth-body); color: var(--auth-text);
  font: 14px/1.55 Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@supports (color: AccentColor) { .void-auth-page { --auth-accent: AccentColor; --auth-on-accent: AccentColorText; } }
/* Match the neutral administrator dashboard's radii, including its rounded fallback. */
@supports (corner-shape: squircle) {
  .void-auth-page { --auth-radius-inner: .75rem; --auth-radius-element: 1.25rem; --auth-radius-container: 1.5rem; }
  .void-auth-page, .void-auth-page *, .void-auth-page *::before, .void-auth-page *::after { corner-shape: squircle; }
  .void-auth-page .void-auth-status { corner-shape: round; }
}
.void-auth-page *, .void-auth-page *::before, .void-auth-page *::after { box-sizing: border-box; }
.void-auth-page .void-auth-container { width: 100%; max-width: 448px; margin: 0 auto; }
.void-auth-page .void-auth-brand { display: flex; align-items: center; gap: 12px; margin: 0 4px 24px; color: var(--auth-secondary); overflow-wrap: anywhere; }
.void-auth-page .void-auth-logo { display: flex; flex: 0 0 70px; color: var(--auth-text); }
.void-auth-page .void-auth-logo svg { display: block; width: 70px; height: auto; }
.void-auth-page .void-auth-divider { width: 1px; height: 18px; background: var(--auth-border); flex-shrink: 0; }
.void-auth-page .void-auth-card { display: grid; gap: 24px; min-width: 0; padding: 24px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-container); background: var(--auth-card); }
.void-auth-page .void-auth-lead { display: grid; gap: 10px; }
.void-auth-page .void-auth-section { display: grid; gap: 12px; min-width: 0; }
.void-auth-page h1 { margin: 0; font-family: inherit; font-size: 26px; font-weight: 600; line-height: 1.2; letter-spacing: -.5px; color: var(--auth-text); overflow-wrap: anywhere; }
.void-auth-page h2 { margin: 0; font-family: inherit; font-size: 18px; font-weight: 600; line-height: 1.3; color: var(--auth-text); overflow-wrap: anywhere; }
.void-auth-page p { margin: 0; font: inherit; color: var(--auth-secondary); overflow-wrap: anywhere; }
.void-auth-page strong { font-weight: 600; color: var(--auth-text); }
.void-auth-page a:not(.void-auth-button) { color: var(--auth-text); text-underline-offset: 3px; }
.void-auth-page form { display: grid; gap: 12px; }
.void-auth-page .void-auth-actions { display: grid; gap: 8px; }
.void-auth-page .void-auth-button { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 44px; padding: 10px 16px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-element); background: var(--auth-body); color: var(--auth-text); font: inherit; font-weight: 550; line-height: 1.4; text-align: center; text-decoration: none; overflow-wrap: anywhere; cursor: pointer; }
.void-auth-page .void-auth-button-primary { background: var(--auth-accent); color: var(--auth-on-accent); border-color: var(--auth-accent); }
.void-auth-page .void-auth-button:hover { filter: brightness(.92); }
.void-auth-page :is(a, button, input):focus-visible { outline: 2px solid var(--auth-accent); outline-offset: 3px; }
.void-auth-page .void-auth-form { display: grid; gap: 10px; }
.void-auth-page label { font-weight: 550; }
.void-auth-page input:not([type=hidden]) { width: 100%; min-width: 0; height: 44px; padding: 0 12px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-element); background: var(--auth-body); color: var(--auth-text); font: inherit; }
.void-auth-page .void-auth-form button { margin-top: 8px; }
.void-auth-page .void-auth-identity { margin: 0; padding: 8px 14px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-inner); background: var(--auth-body); }
.void-auth-page .void-auth-identity > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 16px; padding: 10px 0; }
.void-auth-page .void-auth-identity > div + div { border-top: 1px solid var(--auth-border); }
.void-auth-page dt { color: var(--auth-secondary); font-size: 13px; }
.void-auth-page dd { margin: 0; overflow-wrap: anywhere; }
.void-auth-page .void-auth-note { font-size: 13px; color: var(--auth-secondary); }
.void-auth-page pre { margin: 0; padding: 14px; border: 1px solid var(--auth-border); border-radius: var(--auth-radius-container); background: var(--auth-body); white-space: pre-wrap; overflow-wrap: anywhere; }
.void-auth-page code { font: 13px/1.6 ui-monospace, "SF Mono", Monaco, Consolas, monospace; }
.void-auth-page p code { padding: 2px 7px; background: light-dark(#e5e5e5, #343434); color: var(--auth-text); border-radius: 24px; corner-shape: squircle; white-space: nowrap; }
.void-auth-page .void-auth-status { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; font-size: 22px; font-weight: 650; }
.void-auth-page .void-auth-status-success { color: var(--auth-success); background: var(--auth-success-bg); }
.void-auth-page .void-auth-status-error { color: var(--auth-error); background: var(--auth-error-bg); }
@media (max-width: 500px) { .void-auth-page h1 { font-size: 24px; } }
`;

export function escapeBrowserHtml(value: string): string {
  return value.replaceAll(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

export function browserPageIdentity(identity: {
  login: string;
  issuer: string;
  subject: string;
}): string {
  return (
    '<dl class="void-auth-identity">' +
    [
      ['Account', identity.login],
      ['Provider', identity.issuer],
      ['Identity', identity.subject],
    ]
      .map(
        ([label, value]) =>
          '<div><dt>' + label + '</dt><dd>' + escapeBrowserHtml(value!) + '</dd></div>',
      )
      .join('') +
    '</dl>'
  );
}

export function browserPageStatus(status: 'success' | 'error'): string {
  return (
    '<div class="void-auth-status void-auth-status-' +
    status +
    '" aria-label="' +
    (status === 'success' ? 'Success' : 'Error') +
    '">' +
    (status === 'success' ? '✓' : '!') +
    '</div>'
  );
}

/** content is trusted markup; escape every dynamic value before composing it. */
export function renderBrowserPage({
  title,
  platformName = 'Void',
  content,
}: {
  title: string;
  platformName?: string;
  content: string;
}): string {
  const pageTitle =
    title + ' · ' + platformName + (/\bvoid\b/i.test(platformName) ? '' : ' · Void');
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>' +
    escapeBrowserHtml(pageTitle) +
    '</title><style>body{margin:0}' +
    browserPageStyles +
    '</style></head><body><main class="void-auth-page"><div class="void-auth-container"><div class="void-auth-brand"><span class="void-auth-logo">' +
    browserPageLogo +
    '</span><span class="void-auth-divider" aria-hidden="true"></span><span>' +
    escapeBrowserHtml(platformName) +
    '</span></div><section class="void-auth-card" aria-labelledby="void-auth-title">' +
    content +
    '</section></div></main></body></html>'
  );
}

export function browserPageLead(title: string, description: string): string {
  return (
    '<div class="void-auth-lead"><h1 id="void-auth-title">' +
    escapeBrowserHtml(title) +
    '</h1><p>' +
    escapeBrowserHtml(description) +
    '</p></div>'
  );
}
