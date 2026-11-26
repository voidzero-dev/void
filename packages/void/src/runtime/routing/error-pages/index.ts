import notFoundPage from './404.html?raw';
import serverErrorPage from './500.html?raw';
import { inlineErrorPageAssets } from './inline.ts';
import script from './script.js?raw';
import stylesheet from './style.css?raw';

const pages = {
  404: inlineErrorPageAssets(notFoundPage, stylesheet, script),
  500: inlineErrorPageAssets(serverErrorPage, stylesheet, script),
};

export function renderDefaultErrorPage(status: 404 | 500): string {
  return pages[status];
}
