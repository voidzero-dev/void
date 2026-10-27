import notFoundPage from './404.html?raw';
import serverErrorPage from './500.html?raw';
import script from './script.js?raw';
import stylesheet from './style.css?raw';

const pages = { 404: notFoundPage, 500: serverErrorPage };

export function renderDefaultErrorPage(status: 404 | 500): string {
  return pages[status]
    .replace('<link rel="stylesheet" href="./style.css" />', () => `<style>\n${stylesheet}</style>`)
    .replace('<script src="./script.js"></script>', () => `<script>\n${script}</script>`);
}
