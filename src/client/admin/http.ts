import { api, ApiError, DEFAULT_TIMEOUT_MS, NETWORK_MESSAGE, TIMEOUT_MESSAGE, downloadFile, renderQrObjectUrl, type ApiInit } from '../api';

/** Fired on `window` when a signed-in request gets 401: the session expired or was ended elsewhere. */
export const UNAUTHORIZED_EVENT = 'gatepass:unauthorized';

function reportUnauthorized(err: unknown): never {
  if (err instanceof ApiError && err.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  throw err;
}

/** `api` for signed-in admin pages: a 401 returns the whole app to the sign-in screen. */
export function adminApi<T>(path: string, init?: ApiInit): Promise<T> {
  return api<T>(path, init).catch(reportUnauthorized);
}

/** Server-rendered CSV export (attendance, scans, audit). */
export function adminDownload(path: string): Promise<void> {
  return downloadFile(path).catch(reportUnauthorized);
}

export function adminQrUrl(data: string, config: unknown, file: 'svg' | 'png' = 'svg'): Promise<string> {
  return renderQrObjectUrl(data, config, file).catch(reportUnauthorized);
}

export interface Page<T> {
  items: T[];
  /** All matching rows on the server (`X-Total-Count`). */
  total: number;
}

/** GET a paginated list: the JSON array plus the `X-Total-Count` header that `api` does not expose. */
export async function fetchPage<T>(path: string): Promise<Page<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, { credentials: 'same-origin', signal: controller.signal });
    text = await response.text();
  } catch (err) {
    if (timedOut) throw new ApiError(0, TIMEOUT_MESSAGE, null, 'timeout');
    if (err instanceof TypeError) throw new ApiError(0, NETWORK_MESSAGE, null, 'network');
    throw err;
  } finally {
    clearTimeout(deadline);
  }
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy error page is not JSON; the status code still tells the story.
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `Request failed (${response.status})`;
    reportUnauthorized(new ApiError(response.status, message));
  }
  const items = Array.isArray(data) ? (data as T[]) : [];
  const total = Number(response.headers.get('X-Total-Count'));
  return { items, total: Number.isFinite(total) && response.headers.has('X-Total-Count') ? total : items.length };
}

