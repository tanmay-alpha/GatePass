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
}

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

/** JSON fetch with bearer auth and a timeout. Throws ApiError with the server's message on non-2xx. */
export function api<T>(path: string, token: string, init: ApiInit = {}): Promise<T> {
  return withDeadline(init, async (signal) => {
    const response = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal
    });
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

/** Renders a QR code through the admin-only QR endpoint and returns an object URL. */
export function renderQrObjectUrl(token: string, data: string, config: unknown, file: 'svg' | 'png' = 'svg'): Promise<string> {
  return withDeadline({}, async (signal) => {
    const response = await fetch('/api/qr/custom', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, file, size: 400, config }),
      signal
    });
    if (!response.ok) throw new ApiError(response.status, response.status === 401 ? 'Sign in again to render QR codes' : 'QR render failed');
    return URL.createObjectURL(await response.blob());
  });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** HH:MM, with the date prepended when it is not today. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** `datetime-local` inputs use local time without a zone. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}
