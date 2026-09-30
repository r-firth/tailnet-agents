// REST client + auth token handling.
// If the page was opened as /?token=…, keep the token in a cookie (so <img>
// requests to /api/artifacts are authorised too) and strip it from the URL.

const COOKIE = 'familiar_token';

function readCookie(name: string): string | null {
  const m = document.cookie.split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export function initAuth(): void {
  const url = new URL(location.href);
  const t = url.searchParams.get('token');
  if (t) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE}=${encodeURIComponent(t)}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax${secure}`;
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }
}

export function token(): string | null {
  return readCookie(COOKIE);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(p: string) => req<T>('GET', p),
  post: <T>(p: string, b?: unknown) => req<T>('POST', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => req<T>('PUT', p, b ?? {}),
};

export const artifactUrl = (id: string | null | undefined) => (id ? `/api/artifacts/${encodeURIComponent(id)}` : '');

export function streamUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const t = token();
  return `${proto}//${location.host}/api/stream${t ? `?token=${encodeURIComponent(t)}` : ''}`;
}
