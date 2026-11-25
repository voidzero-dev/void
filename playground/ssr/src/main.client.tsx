import { hydrateRoot } from 'react-dom/client';
import App from './App.tsx';

declare global {
  interface Window {
    __STATE__: {
      visits: number;
      blogContent?: string | null;
    };
  }
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing application root.');
}

hydrateRoot(
  root,
  <App
    url={window.location.pathname}
    visitCount={window.__STATE__.visits}
    blogContent={window.__STATE__.blogContent}
  />,
);
