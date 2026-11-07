import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../ui';

/** Cadence for live operations data. */
export const LIVE_POLL_MS = 5000;

export interface Resource<T> {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => Promise<void>;
}

/** GETs `path` on mount and whenever it changes; responses to superseded requests are dropped. */
export function useResource<T>(path: string, token: string): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    try {
      const data = await api<T>(path, token);
      if (request === latest.current) setState({ data, error: '', loading: false });
    } catch (err) {
      if (request === latest.current) setState((current) => ({ ...current, error: errorMessage(err), loading: false }));
    }
  }, [path, token]);

  useEffect(() => {
    setState((current) => ({ ...current, loading: true }));
    void reload();
  }, [reload]);

  return { ...state, reload };
}

/**
 * Calls `poll` now and then `intervalMs` after each run completes, but only
 * while the page is visible; a hidden tab stops polling and catches up on return.
 */
export function usePolling(poll: () => Promise<void>, intervalMs: number): void {
  useEffect(() => {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      clearTimeout(timer);
      if (stopped || running || document.hidden) return;
      running = true;
      try {
        await poll();
      } finally {
        running = false;
      }
      if (!stopped && !document.hidden) timer = setTimeout(() => void tick(), intervalMs);
    }

    const onVisibility = () => void tick();
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll, intervalMs]);
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
