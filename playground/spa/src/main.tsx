import { createRoot } from 'react-dom/client';
import App from './App.tsx';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing application root.');
}

createRoot(root).render(<App />);
