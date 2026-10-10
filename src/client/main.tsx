import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { mountThemeToggle } from './theme-toggle';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Mount the theme toggle into the .theme-strip rendered by App.tsx.
// Use rAF so React has a chance to commit the DOM first; then poll once
// more on the next frame in case StrictMode double-invocation hasn't
// finalized. Guarded so a missing strip just no-ops.
requestAnimationFrame(() => {
  const strip = document.querySelector<HTMLElement>('.theme-strip');
  if (strip) {
    mountThemeToggle(strip);
  } else {
    requestAnimationFrame(() => {
      const retry = document.querySelector<HTMLElement>('.theme-strip');
      if (retry) mountThemeToggle(retry);
    });
  }
});
