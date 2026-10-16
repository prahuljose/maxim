export type Direction = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

export interface SdpMedia {
  kind: string;
  port: number;
  direction: Direction;
  /** Codecs in offer/answer preference order. */
  codecs: { pt: number; name: string; clockRate: number; channels: number; fmtp: string | null }[];
  candidates: { address: string; port: number; protocol: string; type: string }[];
  ptime: number | null;
}

export interface Sdp {
  origin: string | null;
  sessionName: string | null;
  connectionAddress: string | null;
  iceLite: boolean;
  media: SdpMedia[];
}

/** The updateLog value for set*Description is "type: offer, sdp: v=0\r\n…". */
export function splitDescription(value: string): { type: string | null; sdp: string } {
  const m = value.match(/^type:\s*(\w+),\s*sdp:\s*([\s\S]*)$/);
  return m ? { type: m[1], sdp: m[2] } : { type: null, sdp: value };
}

export function parseSdp(text: string): Sdp {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sdp: Sdp = { origin: null, sessionName: null, connectionAddress: null, iceLite: false, media: [] };
  let cur: SdpMedia | null = null;
  let sessionDirection: Direction = 'sendrecv';
  const rtpmap = new Map<SdpMedia, Map<number, SdpMedia['codecs'][number]>>();

  for (const line of lines) {
    const type = line[0];
    const val = line.slice(2);
    if (type === 'o') sdp.origin = val;
    else if (type === 's') sdp.sessionName = val;
    else if (type === 'c' && !cur) sdp.connectionAddress = val.split(' ')[2] ?? null;
    else if (type === 'm') {
      const [kind, port, , ...pts] = val.split(' ');
      cur = { kind, port: Number(port), direction: sessionDirection, codecs: [], candidates: [], ptime: null };
      const map = new Map<number, SdpMedia['codecs'][number]>();
      for (const pt of pts) {
        const n = Number(pt);
        if (Number.isFinite(n)) map.set(n, { pt: n, name: staticName(n), clockRate: 8000, channels: 1, fmtp: null });
      }
      rtpmap.set(cur, map);
      sdp.media.push(cur);
    } else if (type === 'a') {
      if (val === 'ice-lite') sdp.iceLite = true;
      const dir = val as Direction;
      if (['sendrecv', 'sendonly', 'recvonly', 'inactive'].includes(dir)) {
        if (cur) cur.direction = dir;
        else sessionDirection = dir;
      }
      if (!cur) continue;
      const map = rtpmap.get(cur)!;
      let m: RegExpMatchArray | null;
      if ((m = val.match(/^rtpmap:(\d+)\s+([^/]+)\/(\d+)(?:\/(\d+))?/))) {
        map.set(Number(m[1]), { pt: Number(m[1]), name: m[2], clockRate: Number(m[3]), channels: Number(m[4] ?? 1), fmtp: null });
      } else if ((m = val.match(/^fmtp:(\d+)\s+(.*)$/))) {
        const c = map.get(Number(m[1]));
        if (c) c.fmtp = m[2];
      } else if ((m = val.match(/^candidate:\S+\s+\d+\s+(\S+)\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+(\S+)/i))) {
        cur.candidates.push({ protocol: m[1].toLowerCase(), address: m[2], port: Number(m[3]), type: m[4] });
      } else if ((m = val.match(/^ptime:(\d+)/))) {
        cur.ptime = Number(m[1]);
      }
    }
  }
  for (const [media, map] of rtpmap) media.codecs = [...map.values()];
  return sdp;
}

function staticName(pt: number): string {
  return ({ 0: 'PCMU', 8: 'PCMA', 9: 'G722', 18: 'G729', 13: 'CN' } as Record<number, string>)[pt] ?? `PT${pt}`;
}

/** Audio codecs that carry speech, ignoring DTMF and comfort noise. */
export function speechCodecs(m: SdpMedia) {
  // Dynamic payload types with no rtpmap line ("PT101") can't be named, so leave them out.
  return m.codecs.filter((c) => !/telephone-event|^CN$|red|rtx|ulpfec|^PT\d+$/i.test(c.name));
}
