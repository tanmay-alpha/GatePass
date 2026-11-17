import React, { type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

// Two independent apps, each its own chunk: /scan for door staff downloads only the scanner,
// everything else only the admin. The scanner's service worker precaches its chunks (vite.config.ts).
const isScanner = window.location.pathname.startsWith('/scan');
document.title = isScanner ? 'GatePass Scanner' : 'GatePass Admin';

// One import() per statement: in a single conditional expression the build merged the two
// preload lists, so /scan also fetched the admin chunk (and failed offline without it).
async function loadApp(): Promise<ComponentType> {
  if (isScanner) return (await import('./scanner/ScannerApp')).ScannerApp;
  return (await import('./admin/AdminApp')).AdminApp;
}

const app = loadApp();
const root = createRoot(container);
app.then(
  (App) =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    ),
  // A chunk that cannot be fetched (connection lost mid-load, or a release replaced it): say so rather than show a blank page.
  () => root.render(<p role="alert">GatePass could not load. Check the connection and reload the page.</p>)
);
