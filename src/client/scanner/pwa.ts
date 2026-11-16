import { useEffect, useState } from 'react';

/**
 * Installs the scanner's service worker (public/sw.js, scope /scan) in
 * production builds. It caches the static app shell only; /api/* and /p/*
 * always go to the network, so no verdict can ever come from a cache.
 * Once it is active, the hashed files this page loaded before it took control
 * (fonts, the WebAssembly decoder) are handed to it to cache as well.
 */
export function registerScannerWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register('/sw.js', { scope: '/scan' })
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      const urls = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.startsWith(`${window.location.origin}/assets/`));
      registration.active?.postMessage({ type: 'cache-assets', urls });
    })
    .catch(() => undefined); // Without the worker the scanner still works online; it just cannot start offline.
}

/** True once a service worker controls this page: the scanner app itself opens without a connection. */
export function useOfflineShell(): boolean {
  const [ready, setReady] = useState(() => Boolean(navigator.serviceWorker?.controller));
  useEffect(() => {
    const container = navigator.serviceWorker;
    if (!container) return;
    const update = () => setReady(Boolean(container.controller));
    container.addEventListener('controllerchange', update);
    return () => container.removeEventListener('controllerchange', update);
  }, []);
  return ready;
}
