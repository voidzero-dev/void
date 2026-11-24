import { chromium, webkit } from 'playwright';
import type { Browser } from 'playwright';

/** Select WebKit for cross-engine Pages regressions; normal CI uses Chromium. */
export function launchPagesBrowser(): Promise<Browser> {
  const browser = process.env.VOID_TEST_BROWSER ?? 'chromium';
  if (browser === 'webkit') {
    return webkit.launch();
  }
  if (browser === 'chromium') {
    return chromium.launch({ args: ['--disable-features=BackForwardCache'] });
  }
  throw new Error(`Unsupported VOID_TEST_BROWSER: ${browser}`);
}
