import type { Dump, GetUserMediaEntry, LogEvent, PeerConnection, StatSeries } from './types';

export class DumpError extends Error {}

/** Parse the text of a webrtc-internals dump. Throws DumpError with a readable message. */
export function parseDump(text: string): Dump {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DumpError("This file isn't valid JSON. Export it again from chrome://webrtc-internals or the Voice Debug Console.");
  }
  if (!isObj(raw) || !isObj(raw.PeerConnections)) {
    throw new DumpError("This doesn't look like a webrtc-internals dump — there's no PeerConnections section.");
  }

  const userAgent = typeof raw.UserAgent === 'string' ? raw.UserAgent : null;
  const connections: PeerConnection[] = [];
  for (const [key, pc] of Object.entries(raw.PeerConnections)) {
    if (isObj(pc)) connections.push(parseConnection(key, pc));
  }

  return {
    userAgent,
    browser: parseUserAgent(userAgent),
    getUserMedia: Array.isArray(raw.getUserMedia) ? raw.getUserMedia.filter(isObj).map(parseGum) : [],
    connections,
  };
}

function parseConnection(key: string, pc: Record<string, unknown>): PeerConnection {
  const stats = parseStats(isObj(pc.stats) ? pc.stats : {});
  const statsStart = Math.min(...[...stats.values()].map((s) => s.t[0] ?? Infinity));
  const url = typeof pc.url === 'string' ? pc.url : null;
  return {
    key,
    url,
    sprinklr: parseSprinklrUrl(url),
    rtcConfiguration: typeof pc.rtcConfiguration === 'string' ? pc.rtcConfiguration : null,
    events: parseEvents(Array.isArray(pc.updateLog) ? pc.updateLog : [], Number.isFinite(statsStart) ? statsStart : null),
    stats,
  };
}

/** Stats are flattened as "<statId>-<property>"; ids may themselves contain dashes. */
function parseStats(flat: Record<string, unknown>): Map<string, StatSeries> {
  const groups = new Map<string, { type: string; props: Record<string, { values: unknown[]; start: number; end: number }> }>();
  for (const [key, entry] of Object.entries(flat)) {
    if (!isObj(entry)) continue;
    const cut = key.lastIndexOf('-');
    if (cut <= 0) continue;
    const id = key.slice(0, cut);
    const prop = key.slice(cut + 1);
    const values = decodeValues(entry.values);
    if (!values) continue;
    const g = groups.get(id) ?? { type: String(entry.statsType ?? 'unknown'), props: {} };
    g.props[prop] = { values, start: toMs(entry.startTime) ?? NaN, end: toMs(entry.endTime) ?? NaN };
    groups.set(id, g);
  }

  const out = new Map<string, StatSeries>();
  for (const [id, g] of groups) {
    let t: number[];
    const ts = g.props.timestamp;
    if (ts) {
      t = ts.values.map((v) => toMs(v) ?? NaN);
    } else {
      // No timestamp field: spread the longest series evenly between its start and end.
      const longest = Object.values(g.props).sort((a, b) => b.values.length - a.values.length)[0];
      const n = longest.values.length;
      t = Array.from({ length: n }, (_, i) => (n > 1 ? longest.start + ((longest.end - longest.start) * i) / (n - 1) : longest.start));
    }
    const fields: Record<string, unknown[]> = {};
    for (const [prop, p] of Object.entries(g.props)) {
      if (prop === 'timestamp') continue;
      // A property that appeared mid-call has fewer samples; they line up with the most recent timestamps.
      const pad = t.length - p.values.length;
      fields[prop] = pad >= 0 ? [...Array(pad).fill(null), ...p.values] : p.values.slice(-pad);
    }
    out.set(id, { id, type: g.type, t, fields });
  }
  return out;
}

function decodeValues(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [v];
  }
}

function parseEvents(log: unknown[], statsStart: number | null): LogEvent[] {
  const rows = log.filter(isObj).map((e) => ({
    rawTime: e.time,
    type: String(e.type ?? ''),
    value: typeof e.value === 'string' ? e.value : JSON.stringify(e.value ?? ''),
  }));
  const times = resolveLogTimes(rows.map((r) => r.rawTime), statsStart);
  return rows.map((r, i) => ({ t: times[i], type: r.type, value: r.value })).filter((e) => Number.isFinite(e.t));
}

/**
 * Event times are written with the exporting browser's locale ("08/10/2026, 08:03:43" or
 * "10/8/2026, 8:03:43 AM") and timezone. Try day-first and month-first readings, keep the one
 * that lands near the stats (which are in UTC), then remove the timezone offset.
 */
export function resolveLogTimes(raw: unknown[], statsStart: number | null): number[] {
  const parsed = raw.map(parseLocaleTime);
  const candidates = (['dmy', 'mdy'] as const).map((order) => parsed.map((p) => (p ? p[order] : NaN)));
  if (statsStart === null) return candidates[0];

  const HOUR = 3_600_000;
  const score = (ts: number[]) => {
    const first = ts.find(Number.isFinite);
    return first === undefined ? Infinity : Math.abs(first - statsStart);
  };
  const best = candidates.sort((a, b) => score(a) - score(b))[0];
  const first = best.find(Number.isFinite);
  if (first === undefined || Math.abs(first - statsStart) > 15 * HOUR) return best;

  // Timezones are whole quarter-hours from UTC.
  const QUARTER = 15 * 60_000;
  const offset = Math.round((first - statsStart) / QUARTER) * QUARTER;
  return best.map((t) => t - offset);
}

function parseLocaleTime(v: unknown): { dmy: number; mdy: number } | null {
  if (typeof v === 'number') return { dmy: v, mdy: v };
  if (typeof v !== 'string') return null;
  const iso = Date.parse(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(iso)) return { dmy: iso, mdy: iso };
  const m = v.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*([AaPp][Mm])?/);
  if (!m) return null;
  const [, a, b, y, hh, mm, ss, frac, ampm] = m;
  let h = Number(hh);
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  const at = (day: number, month: number) =>
    day >= 1 && day <= 31 && month >= 1 && month <= 12 ? Date.UTC(Number(y), month - 1, day, h, Number(mm), Number(ss), ms) : NaN;
  return { dmy: at(Number(a), Number(b)), mdy: at(Number(b), Number(a)) };
}

function parseGum(e: Record<string, unknown>): GetUserMediaEntry {
  const str = (k: string) => (typeof e[k] === 'string' && e[k] !== '' ? (e[k] as string) : null);
  return {
    t: toMs(e.timestamp),
    origin: str('origin'),
    audio: str('audio'),
    video: str('video'),
    error: str('error'),
    errorMessage: str('error_message'),
    audioTrackInfo: str('audio_track_info'),
  };
}

export function parseSprinklrUrl(url: string | null): PeerConnection['sprinklr'] {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/sprinklr\.com$/i.test(u.hostname)) return null;
    const q = u.searchParams;
    return {
      host: u.hostname,
      caseNumber: q.get('caseNumber'),
      conversationId: q.get('conversationId'),
      participantId: q.get('participantId'),
    };
  } catch {
    return null;
  }
}

export function parseUserAgent(ua: string | null): Dump['browser'] {
  if (!ua) return { name: 'Unknown', version: null, os: null };
  const os = /Windows NT/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const edge = ua.match(/Edg\/(\d+)/);
  if (edge) return { name: 'Edge', version: Number(edge[1]), os };
  const chrome = ua.match(/Chrome\/(\d+)/);
  if (chrome) return { name: 'Chrome', version: Number(chrome[1]), os };
  return { name: 'Other', version: null, os };
}

function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
