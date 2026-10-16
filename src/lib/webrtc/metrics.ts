import { parseSdp, speechCodecs, splitDescription, type Sdp } from './sdp';
import type { LogEvent, PeerConnection, StatSeries } from './types';

/** RMS level (0–1) above which we treat a side as making sound. Silence on these legs reads 0.000. */
export const AUDIBLE_RMS = 0.005;

/** One interval between two consecutive stats samples. Null means "not available in this dump". */
export interface Sample {
  t0: number;
  t: number;
  dt: number;
  /** What the agent receives (far end → agent). */
  inLossPct: number | null;
  inJitterMs: number | null;
  jitterBufferMs: number | null;
  concealPct: number | null;
  inKbps: number | null;
  inPps: number | null;
  farRms: number | null;
  /** What the agent sends (agent → far end). */
  outKbps: number | null;
  outPps: number | null;
  micRms: number | null;
  micEnabled: boolean | null;
  /** The far end's RTCP reports about the agent's stream. */
  remoteLossPct: number | null;
  remoteJitterMs: number | null;
  rttMs: number | null;
  availableOutKbps: number | null;
  /** Agent's speaker/headset couldn't be fed in time (ms of synthesized audio). */
  playoutGlitchMs: number | null;
  /** Estimated MOS for what the agent hears, and for what the far end hears of the agent. */
  mosIn: number | null;
  mosOut: number | null;
}

export interface Candidate {
  id: string;
  isRemote: boolean;
  address: string | null;
  port: number | null;
  protocol: string | null;
  candidateType: string | null;
  networkType: string | null;
  relayProtocol: string | null;
  url: string | null;
  relatedAddress: string | null;
}

export interface CodecInfo {
  mimeType: string;
  name: string;
  clockRate: number;
  channels: number;
  wideband: boolean;
}

export interface Negotiation {
  t: number;
  side: 'remote' | 'local';
  type: string | null;
  sdp: Sdp;
  raw: string;
}

export interface StateChange {
  t: number;
  kind: string;
  state: string;
}

export interface CallMetrics {
  pc: PeerConnection;
  hasStats: boolean;
  start: number | null;
  end: number | null;
  durationMs: number;
  /** Typical gap between stats samples, so we can say how fine-grained the data is. */
  cadenceMs: number | null;
  ids: Partial<Record<'inbound' | 'outbound' | 'source' | 'remoteInbound' | 'pair' | 'transport' | 'playout', string>>;
  samples: Sample[];
  codecIn: CodecInfo | null;
  codecOut: CodecInfo | null;
  candidates: Candidate[];
  local: Candidate | null;
  remote: Candidate | null;
  pairSwitches: { t: number; pairId: string }[];
  deviceLabels: { t: number; label: string }[];
  negotiations: Negotiation[];
  states: StateChange[];
  totals: {
    packetsReceived: number | null;
    packetsLost: number | null;
    packetsSent: number | null;
    concealedMs: number | null;
    audioMs: number | null;
    fecRecovered: number | null;
    nackCount: number | null;
    retransmitted: number | null;
    accelerateMs: number | null;
    decelerateMs: number | null;
  };
  security: { dtlsCipher: string | null; srtpCipher: string | null; tlsVersion: string | null };
  echo: { erl: number | null; erle: number | null };
}

// ── series helpers ─────────────────────────────────────────────────────────

function byType(pc: PeerConnection, type: string): StatSeries[] {
  return [...pc.stats.values()].filter((s) => s.type === type);
}

function lastOf(s: StatSeries | undefined, f: string): unknown {
  const v = s?.fields[f];
  if (!v) return null;
  for (let i = v.length - 1; i >= 0; i--) if (v[i] !== null && v[i] !== undefined) return v[i];
  return null;
}

function numAt(s: StatSeries | undefined, f: string, t: number): number | null {
  const v = valAt(s, f, t);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function valAt(s: StatSeries | undefined, f: string, t: number): unknown {
  if (!s || !s.fields[f]) return null;
  const i = nearest(s.t, t);
  if (i < 0 || Math.abs(s.t[i] - t) > 1500) return null;
  return s.fields[f][i] ?? null;
}

function nearest(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(ts[lo - 1] - t) < Math.abs(ts[lo] - t)) return lo - 1;
  return lo;
}

/** Counter change between two sample times; null if missing or reset (renegotiation recreates stats). */
function delta(s: StatSeries | undefined, f: string, t0: number, t1: number): number | null {
  const a = numAt(s, f, t0);
  const b = numAt(s, f, t1);
  if (a === null || b === null || b < a) return null;
  return b - a;
}

const isAudio = (s: StatSeries) => {
  const k = lastOf(s, 'kind') ?? lastOf(s, 'mediaType');
  return k === null || k === 'audio';
};

function pickBusiest(list: StatSeries[], counter: string): StatSeries | undefined {
  return list.filter(isAudio).sort((a, b) => Number(lastOf(b, counter) ?? 0) - Number(lastOf(a, counter) ?? 0))[0];
}

// ── quality estimate ───────────────────────────────────────────────────────

/**
 * Simplified ITU-T G.107 E-model on the narrowband scale. Good for comparing stretches of a
 * call and spotting bad ones; not a substitute for a listening test.
 */
export function estimateMos(lossPct: number, oneWayDelayMs: number, codec: string | null): number {
  const c = (codec ?? '').toUpperCase();
  const { ie, bpl } = c.includes('G729') ? { ie: 11, bpl: 19 } : c.includes('OPUS') ? { ie: 0, bpl: 20 } : { ie: 0, bpl: 25.1 };
  const ppl = Math.max(0, Math.min(100, lossPct));
  const ieEff = ie + ((95 - ie) * ppl) / (ppl + bpl);
  const d = Math.max(0, oneWayDelayMs);
  const id = 0.024 * d + (d > 177.3 ? 0.11 * (d - 177.3) : 0);
  const r = Math.max(0, Math.min(100, 93.2 - id - ieEff));
  return 1 + 0.035 * r + r * (r - 60) * (100 - r) * 7e-6;
}

// ── main derivation ────────────────────────────────────────────────────────

export function deriveMetrics(pc: PeerConnection): CallMetrics {
  const inbound = pickBusiest(byType(pc, 'inbound-rtp'), 'packetsReceived');
  const outbound = pickBusiest(byType(pc, 'outbound-rtp'), 'packetsSent');
  const source = byType(pc, 'media-source').filter(isAudio)[0];
  const remoteInbound =
    byType(pc, 'remote-inbound-rtp').find((s) => outbound && lastOf(s, 'localId') === outbound.id) ?? byType(pc, 'remote-inbound-rtp')[0];
  const transport = byType(pc, 'transport')[0];
  const playout = byType(pc, 'media-playout')[0];
  const pairs = byType(pc, 'candidate-pair');
  const selectedId = lastOf(transport, 'selectedCandidatePairId');
  const pair =
    pairs.find((p) => p.id === selectedId) ??
    pairs.sort((a, b) => Number(lastOf(b, 'bytesReceived') ?? 0) - Number(lastOf(a, 'bytesReceived') ?? 0))[0];

  const candidates: Candidate[] = [...byType(pc, 'local-candidate'), ...byType(pc, 'remote-candidate')].map((s) => ({
    id: s.id,
    isRemote: s.type === 'remote-candidate' || lastOf(s, 'isRemote') === true,
    address: (lastOf(s, 'address') ?? lastOf(s, 'ip')) as string | null,
    port: lastOf(s, 'port') as number | null,
    protocol: lastOf(s, 'protocol') as string | null,
    candidateType: lastOf(s, 'candidateType') as string | null,
    networkType: lastOf(s, 'networkType') as string | null,
    relayProtocol: lastOf(s, 'relayProtocol') as string | null,
    url: lastOf(s, 'url') as string | null,
    relatedAddress: lastOf(s, 'relatedAddress') as string | null,
  }));
  const local = candidates.find((c) => c.id === lastOf(pair, 'localCandidateId')) ?? null;
  const remote = candidates.find((c) => c.id === lastOf(pair, 'remoteCandidateId')) ?? null;

  const codecOf = (rtp: StatSeries | undefined): CodecInfo | null => {
    const id = lastOf(rtp, 'codecId');
    const c = typeof id === 'string' ? pc.stats.get(id) : undefined;
    const mime = lastOf(c, 'mimeType');
    if (typeof mime !== 'string') return null;
    const clockRate = Number(lastOf(c, 'clockRate') ?? 8000);
    const name = mime.split('/')[1] ?? mime;
    return { mimeType: mime, name, clockRate, channels: Number(lastOf(c, 'channels') ?? 1), wideband: /opus|G722/i.test(name) || clockRate >= 16000 };
  };
  const codecIn = codecOf(inbound);
  const codecOut = codecOf(outbound);

  // Base timeline: whichever series describes the media best.
  const base = inbound ?? outbound ?? pair ?? transport;
  const ts = base ? base.t.filter(Number.isFinite) : [];
  const samples: Sample[] = [];
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1];
    const t = ts[i];
    const dt = (t - t0) / 1000;
    if (dt <= 0) continue;

    const rx = delta(inbound, 'packetsReceived', t0, t);
    const lost = delta(inbound, 'packetsLost', t0, t);
    const inLossPct = rx !== null && lost !== null && rx + lost > 0 ? (100 * lost) / (rx + lost) : null;

    const recv = delta(inbound, 'totalSamplesReceived', t0, t);
    const conc = delta(inbound, 'concealedSamples', t0, t);
    const silentConc = delta(inbound, 'silentConcealedSamples', t0, t) ?? 0;
    const concealPct = recv && conc !== null ? Math.max(0, (100 * (conc - silentConc)) / recv) : null;

    const jbd = delta(inbound, 'jitterBufferDelay', t0, t);
    const jbe = delta(inbound, 'jitterBufferEmittedCount', t0, t);
    const jitterBufferMs = jbd !== null && jbe ? (1000 * jbd) / jbe : null;

    const rmsFrom = (s: StatSeries | undefined) => {
      const e = delta(s, 'totalAudioEnergy', t0, t);
      const d = delta(s, 'totalSamplesDuration', t0, t);
      if (e !== null && d) return Math.sqrt(Math.max(0, e) / d);
      return numAt(s, 'audioLevel', t);
    };

    const kbps = (s: StatSeries | undefined, f: string) => {
      const b = delta(s, f, t0, t);
      return b === null ? null : (8 * b) / dt / 1000;
    };
    const pps = (s: StatSeries | undefined, f: string) => {
      const p = delta(s, f, t0, t);
      return p === null ? null : p / dt;
    };

    const enabled = valAt(source, 'enabled', t);
    const rttS = numAt(remoteInbound, 'roundTripTime', t) ?? numAt(pair, 'currentRoundTripTime', t);
    const frac = numAt(remoteInbound, 'fractionLost', t);
    const glitch = delta(playout, 'synthesizedSamplesDuration', t0, t);
    const avail = numAt(pair, 'availableOutgoingBitrate', t);

    const s: Sample = {
      t0,
      t,
      dt,
      inLossPct,
      inJitterMs: mul(numAt(inbound, 'jitter', t), 1000),
      jitterBufferMs,
      concealPct,
      inKbps: kbps(inbound, 'bytesReceived'),
      inPps: pps(inbound, 'packetsReceived'),
      farRms: rmsFrom(inbound),
      outKbps: kbps(outbound, 'bytesSent'),
      outPps: pps(outbound, 'packetsSent'),
      micRms: rmsFrom(source),
      micEnabled: typeof enabled === 'boolean' ? enabled : null,
      remoteLossPct: frac === null ? null : frac * 100,
      remoteJitterMs: mul(numAt(remoteInbound, 'jitter', t), 1000),
      rttMs: mul(rttS, 1000),
      availableOutKbps: avail === null ? null : avail / 1000,
      playoutGlitchMs: mul(glitch, 1000),
      mosIn: null,
      mosOut: null,
    };
    // Concealment counts late packets the jitter buffer gave up on, so it's the audible loss.
    // One-way delay ≈ half the round trip + receive buffering + 20 ms packetisation + ~10 ms processing.
    const half = s.rttMs === null ? 30 : s.rttMs / 2;
    if (s.inLossPct !== null) s.mosIn = estimateMos(Math.max(s.inLossPct, s.concealPct ?? 0), half + (s.jitterBufferMs ?? 40) + 30, codecIn?.name ?? null);
    if (s.remoteLossPct !== null) s.mosOut = estimateMos(s.remoteLossPct, half + 40 + 30, codecOut?.name ?? null);
    samples.push(s);
  }

  // Pair switches (network change, ICE restart) from the transport's selected pair over time.
  const pairSwitches: CallMetrics['pairSwitches'] = [];
  if (transport?.fields.selectedCandidatePairId) {
    let prev: unknown = null;
    transport.fields.selectedCandidatePairId.forEach((id, i) => {
      if (id && id !== prev) {
        if (prev !== null) pairSwitches.push({ t: transport.t[i], pairId: String(id) });
        prev = id;
      }
    });
  }

  const deviceLabels: CallMetrics['deviceLabels'] = [];
  if (source?.fields.deviceLabel) {
    let prev: unknown = null;
    source.fields.deviceLabel.forEach((l, i) => {
      if (typeof l === 'string' && l !== prev) {
        deviceLabels.push({ t: source.t[i], label: l });
        prev = l;
      }
    });
  }

  const tSorted = [...pc.events.map((e) => e.t), ...ts].filter(Number.isFinite).sort((a, b) => a - b);
  const start = tSorted[0] ?? null;
  const end = tSorted.at(-1) ?? null;

  const gaps = samples.map((s) => s.t - s.t0).sort((a, b) => a - b);
  const cadenceMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;

  const sumMs = (s: StatSeries | undefined, f: string, rate: number | null) => {
    const v = lastOf(s, f);
    return typeof v === 'number' && rate ? (1000 * v) / rate : null;
  };
  const inRate = codecIn?.clockRate ?? null;

  return {
    pc,
    hasStats: pc.stats.size > 0,
    start,
    end,
    durationMs: start !== null && end !== null ? end - start : 0,
    cadenceMs,
    ids: {
      inbound: inbound?.id,
      outbound: outbound?.id,
      source: source?.id,
      remoteInbound: remoteInbound?.id,
      pair: pair?.id,
      transport: transport?.id,
      playout: playout?.id,
    },
    samples,
    codecIn,
    codecOut,
    candidates,
    local,
    remote,
    pairSwitches,
    deviceLabels,
    negotiations: negotiationsOf(pc.events),
    states: statesOf(pc.events),
    totals: {
      packetsReceived: lastOf(inbound, 'packetsReceived') as number | null,
      packetsLost: lastOf(inbound, 'packetsLost') as number | null,
      packetsSent: lastOf(outbound, 'packetsSent') as number | null,
      concealedMs: (() => {
        const c = lastOf(inbound, 'concealedSamples');
        const sc = lastOf(inbound, 'silentConcealedSamples') ?? 0;
        return typeof c === 'number' && inRate ? (1000 * (c - Number(sc))) / inRate : null;
      })(),
      audioMs: sumMs(inbound, 'totalSamplesReceived', inRate),
      fecRecovered: lastOf(inbound, 'fecPacketsReceived') as number | null,
      nackCount: lastOf(outbound, 'nackCount') as number | null,
      retransmitted: lastOf(outbound, 'retransmittedPacketsSent') as number | null,
      accelerateMs: sumMs(inbound, 'removedSamplesForAcceleration', inRate),
      decelerateMs: sumMs(inbound, 'insertedSamplesForDeceleration', inRate),
    },
    security: {
      dtlsCipher: lastOf(transport, 'dtlsCipher') as string | null,
      srtpCipher: lastOf(transport, 'srtpCipher') as string | null,
      tlsVersion: lastOf(transport, 'tlsVersion') as string | null,
    },
    echo: { erl: lastOf(source, 'echoReturnLoss') as number | null, erle: lastOf(source, 'echoReturnLossEnhancement') as number | null },
  };
}

function mul(v: number | null, k: number) {
  return v === null ? null : v * k;
}

function negotiationsOf(events: LogEvent[]): Negotiation[] {
  return events
    .filter((e) => e.type === 'setRemoteDescription' || e.type === 'setLocalDescription')
    .map((e) => {
      const { type, sdp } = splitDescription(e.value);
      return { t: e.t, side: e.type === 'setRemoteDescription' ? 'remote' : 'local', type, sdp: parseSdp(sdp), raw: sdp } as Negotiation;
    });
}

const STATE_EVENTS: Record<string, string> = {
  iceconnectionstatechange: 'ICE',
  connectionstatechange: 'Connection',
  signalingstatechange: 'Signalling',
  icegatheringstatechange: 'ICE gathering',
  dtlstransportstatechange: 'DTLS',
};

function statesOf(events: LogEvent[]): StateChange[] {
  return events
    .filter((e) => STATE_EVENTS[e.type])
    .map((e) => ({ t: e.t, kind: STATE_EVENTS[e.type], state: e.value.replace(/^"|"$/g, '').trim() }));
}

/** Percentile of the non-null values. */
export function pctl(values: (number | null)[], p: number): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
}

export function mean(values: (number | null)[], weights?: number[]): number | null {
  let s = 0;
  let w = 0;
  values.forEach((x, i) => {
    if (x === null || !Number.isFinite(x)) return;
    const k = weights ? weights[i] : 1;
    s += x * k;
    w += k;
  });
  return w ? s / w : null;
}

export { speechCodecs };
