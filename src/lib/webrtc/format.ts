/** "4:07" or "1:02:33" — elapsed time from the start of the call. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "2 min 14 s", "45 s", "1 h 3 min". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function fixed(v: number | null | undefined, dp = 1, unit = ''): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(dp)}${unit}`;
}

/** Mask the host part of IPv4 addresses and the tail of IPv6 ones. */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return '—';
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  if (ip.includes(':')) return ip.split(':').slice(0, 2).join(':') + ':…';
  return ip.replace(/.(?=.{4})/g, '•');
}

/** Replace every IPv4/IPv6 address in free text. */
export function maskIpsInText(text: string): string {
  return text
    .replace(/\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, '$1.$2.x.x')
    .replace(/\b([0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f:]{3,}\b/gi, '$1:…');
}
