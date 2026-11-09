import { defineMiddleware } from 'void';

declare module 'void' {
  interface CloudContextVariables {
    shared: { appName: string; scriptProbe: string };
  }
}

// Regression payload for the inline page-data script-tag escape. If anything
// in the SSR pipeline forgets to escape, the embedded <script> closes early
// and JSON.parse fails on hydration.
const SCRIPT_PROBE = '</script><script>alert(1)</script>\u2028\u2029&';

export default defineMiddleware(async (c, next) => {
  c.set('shared', {
    appName: 'Hono Pages Demo',
    scriptProbe: SCRIPT_PROBE,
  });
  await next();
});
