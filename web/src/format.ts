export const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** 66000 -> "1:06", 3700000 -> "1:01:40" */
export function dur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
}
/** action-log style "01.06" (mm.ss) */
export function tplus(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 100 ? `${m}m` : `${pad2(m)}.${pad2(s % 60)}`;
}
export function gbp(p: number | null | undefined, opts: { short?: boolean } = {}): string {
  const v = (p || 0) / 100;
  if (opts.short && Math.abs(v - Math.round(v)) < 0.005) return '£' + Math.round(v).toLocaleString('en-GB');
  return '£' + v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function tokens(n: number | null | undefined): string {
  const v = n || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return Math.round(v / 1e3) + 'k';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
}
export function clock(d: Date = new Date(), secs = true): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${secs ? ':' + pad2(d.getSeconds()) : ''}`;
}
export function timeOf(iso: string | null | undefined, secs = false): string {
  if (!iso) return '';
  return clock(new Date(iso), secs);
}
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000;
  if (diff <= 0) return clock(d, false);
  if (diff === 1) return 'Yesterday ' + clock(d, false);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export function uptime(s: number): string {
  if (!s) return '—';
  if (s < 3600) return dur(s * 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${pad2(m)}m`;
}
export function splitUrl(u: string | null | undefined): { host: string; path: string; secure: boolean } | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    if (x.protocol === 'desktop:' || x.protocol === 'term:') return { host: x.host || u.split('//')[1]?.split('/')[0] || u, path: decodeURIComponent(x.pathname), secure: false };
    return { host: x.host.replace(/^www\./, ''), path: x.pathname + x.search, secure: x.protocol === 'https:' };
  } catch { return { host: u, path: '', secure: false }; }
}
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
