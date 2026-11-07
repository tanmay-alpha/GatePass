export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds from the `Retry-After` header on 429 responses. */
    readonly retryAfter: number | null = null
  ) {
    super(message);
  }
}

function parseRetryAfter(response: Response): number | null {
  const value = Number(response.headers.get('Retry-After'));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

/** JSON fetch with bearer auth. Throws ApiError with the server's message on non-2xx. */
export async function api<T>(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
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
}

/** Renders a QR code through the admin-only QR endpoint and returns an object URL. */
export async function renderQrObjectUrl(token: string, data: string, config: unknown, file: 'svg' | 'png' = 'svg'): Promise<string> {
  const response = await fetch('/api/qr/custom', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, file, size: 400, config })
  });
  if (!response.ok) throw new ApiError(response.status, response.status === 401 ? 'Sign in again to render QR codes' : 'QR render failed');
  return URL.createObjectURL(await response.blob());
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
