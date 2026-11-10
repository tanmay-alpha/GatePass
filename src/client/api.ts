/** Why a request failed: an HTTP error response, no response in time, or no connection at all. */
export type ApiFailure = 'http' | 'timeout' | 'network';

export class ApiError extends Error {
  constructor(
    /** HTTP status; 0 when no response arrived (timeout or network failure). */
    readonly status: number,
    message: string,
    /** Seconds from the `Retry-After` header on 429 responses. */
    readonly retryAfter: number | null = null,
    readonly failure: ApiFailure = 'http'
  ) {
    super(message);
  }
}

/** Default time a request may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Default delay before `onSlow` fires. */
export const SLOW_AFTER_MS = 3_000;
export const TIMEOUT_MESSAGE = 'The server did not respond. Check your connection and try again.';
export const NETWORK_MESSAGE = 'Cannot reach the server. Check your connection.';
/** What to show once `onSlow` fires: the free demo backend sleeps when idle. */
export const WAKING_MESSAGE = 'Waking up the server… this can take up to a minute on the free demo.';

export interface RequestOptions {
  /** Abandon the request after this many milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Called once if the request is still pending after `slowAfterMs`. */
  onSlow?: () => void;
  /** Defaults to {@link SLOW_AFTER_MS}. */
  slowAfterMs?: number;
}

export interface ApiInit extends RequestOptions {
  method?: string;
  body?: unknown;
  /** Bearer credential (scanner device key). Admin pages omit it and rely on the session cookie. */
  bearer?: string;
}

/**
 * Cookie-authenticated requests that change state must carry this header
 * (CSRF defense: a cross-site form or image cannot set it, and a cross-site
 * fetch that sets it needs a CORS preflight the server never approves).
 */
export const CSRF_HEADER = { 'X-GatePass-CSRF': '1' } as const;

function parseRetryAfter(response: Response): number | null {
  const value = Number(response.headers.get('Retry-After'));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

/**
 * Runs `read` (fetch plus body read) under one deadline. Timeouts and network
 * failures become ApiError with status 0 and plain-language messages.
 */
async function withDeadline<T>(options: RequestOptions, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onSlow = options.onSlow;
  const slow = onSlow ? setTimeout(onSlow, options.slowAfterMs ?? SLOW_AFTER_MS) : undefined;
  try {
    return await read(controller.signal);
  } catch (err) {
    if (timedOut) throw new ApiError(0, TIMEOUT_MESSAGE, null, 'timeout');
    // fetch rejects with a TypeError when the network fails (offline, DNS, connection reset).
    if (err instanceof TypeError) throw new ApiError(0, NETWORK_MESSAGE, null, 'network');
    throw err;
  } finally {
    clearTimeout(deadline);
    clearTimeout(slow);
  }
}

/**
 * JSON fetch with the session cookie (or `init.bearer`) and a timeout.
 * Throws ApiError with the server's message on non-2xx.
 */
export function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  return withDeadline(init, async (signal) => {
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
        ...(method === 'GET' || method === 'HEAD' ? {} : CSRF_HEADER),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal
    });
    if (response.status === 204) return null as T;
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // A proxy error page is not JSON; the status code still tells the story.
    }
    if (!response.ok) {
      const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `Request failed (${response.status})`;
      throw new ApiError(response.status, message, parseRetryAfter(response));
    }
    return data as T;
  });
}

/** Renders a QR code through the signed-in-only QR endpoint and returns an object URL. */
export function renderQrObjectUrl(data: string, config: unknown, file: 'svg' | 'png' = 'svg'): Promise<string> {
  return withDeadline({}, async (signal) => {
    const response = await fetch('/api/qr/custom', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...CSRF_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, file, size: 400, config }),
      signal
    });
    if (!response.ok) throw new ApiError(response.status, response.status === 401 ? 'Sign in again to render QR codes' : 'QR render failed');
    return URL.createObjectURL(await response.blob());
  });
}

/** Downloads a server-generated file (CSV export) through the session cookie. */
export function downloadFile(path: string): Promise<void> {
  return withDeadline({ timeoutMs: 60_000 }, async (signal) => {
    const response = await fetch(path, { credentials: 'same-origin', signal });
    if (!response.ok) {
      const text = await response.text();
      let message = `Download failed (${response.status})`;
      try {
        const data: unknown = JSON.parse(text);
        if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') message = data.error;
      } catch {
        // not JSON
      }
      throw new ApiError(response.status, message);
    }
    const filename = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'export.csv';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
}

/** HH:MM, with the date prepended when it is not today. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
