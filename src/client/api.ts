export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
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
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}

/** Renders a pass QR through the retained QR endpoint and returns an object URL. */
export async function renderQrObjectUrl(data: string, config: unknown, file: 'svg' | 'png' = 'svg'): Promise<string> {
  const response = await fetch('/api/qr/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, file, size: 400, config })
  });
  if (!response.ok) throw new ApiError(response.status, 'QR render failed');
  return URL.createObjectURL(await response.blob());
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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
