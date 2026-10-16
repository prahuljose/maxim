/**
 * Builds synthetic webrtc-internals dumps in Chrome's export format, so each diagnosis rule can be
 * tested against a call with exactly one known problem.
 */
export interface SecondOpts {
  /** Fraction of inbound packets lost this second. */
  loss?: number;
  /** Fraction of the agent's packets the far end reports lost. */
  remoteLoss?: number;
  jitterMs?: number;
  rttMs?: number;
  /** Fraction of received audio concealed (non-silent). */
  conceal?: number;
  farRms?: number;
  micRms?: number;
  micEnabled?: boolean;
  inPackets?: number;
  outPackets?: number;
  glitchMs?: number;
}

export interface FixtureOpts {
  seconds: number;
  at?: (i: number) => SecondOpts;
  local?: Record<string, unknown>;
  deviceLabel?: string;
  codec?: string;
  /** Extra updateLog entries: [secondOffset, type, value]. */
  events?: [number, string, string][];
  close?: boolean;
}

const START = Date.UTC(2026, 9, 8, 8, 0, 0);
const OFFER = 'type: offer, sdp: v=0\r\no=SPR-Media-Server 1 2 IN IP4 198.51.100.20\r\ns=SPR-Media-Server\r\nm=audio 38342 RTP/SAVPF 0 8 102 101\r\nc=IN IP4 198.51.100.20\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:102 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\na=sendrecv\r\na=candidate:x 1 UDP 2130706431 198.51.100.20 38342 typ host\r\n';
const ANSWER = 'type: answer, sdp: v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 RTP/SAVPF 0 8 102 101\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:102 opus/48000/2\r\na=sendrecv\r\n';

function clock(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function makeDump(o: FixtureOpts): string {
  const n = o.seconds + 1;
  const ts = Array.from({ length: n }, (_, i) => new Date(START + 2000 + i * 1000).toISOString());
  const series: Record<string, { type: string; props: Record<string, unknown[]> }> = {};
  const put = (id: string, type: string, prop: string, v: unknown) => {
    series[id] ??= { type, props: {} };
    (series[id].props[prop] ??= []).push(v);
  };

  let rx = 0, lost = 0, tx = 0, bytesIn = 0, bytesOut = 0, samples = 0, conc = 0, energyIn = 0, durIn = 0, energyMic = 0, durMic = 0, jbd = 0, jbe = 0, synth = 0;
  for (let i = 0; i < n; i++) {
    const s = i === 0 ? {} : (o.at?.(i) ?? {});
    if (i > 0) {
      const inP = s.inPackets ?? 50;
      const l = Math.round(inP * (s.loss ?? 0));
      rx += inP - l;
      lost += l;
      bytesIn += (inP - l) * 172;
      const outP = s.outPackets ?? 50;
      tx += outP;
      bytesOut += outP * 172;
      samples += inP > 0 ? 8000 : 0;
      conc += Math.round(8000 * (s.conceal ?? 0));
      energyIn += (s.farRms ?? 0) ** 2;
      durIn += 1;
      energyMic += (s.micRms ?? 0) ** 2;
      durMic += 1;
      jbd += 0.06 * 8000;
      jbe += 8000;
      synth += (s.glitchMs ?? 0) / 1000;
    }
    put('IT01', 'inbound-rtp', 'kind', 'audio');
    put('IT01', 'inbound-rtp', 'codecId', 'CIT01_0');
    put('IT01', 'inbound-rtp', 'packetsReceived', rx);
    put('IT01', 'inbound-rtp', 'packetsLost', lost);
    put('IT01', 'inbound-rtp', 'bytesReceived', bytesIn);
    put('IT01', 'inbound-rtp', 'jitter', (s.jitterMs ?? 1) / 1000);
    put('IT01', 'inbound-rtp', 'totalSamplesReceived', samples);
    put('IT01', 'inbound-rtp', 'concealedSamples', conc);
    put('IT01', 'inbound-rtp', 'silentConcealedSamples', 0);
    put('IT01', 'inbound-rtp', 'totalAudioEnergy', energyIn);
    put('IT01', 'inbound-rtp', 'totalSamplesDuration', durIn);
    put('IT01', 'inbound-rtp', 'jitterBufferDelay', jbd);
    put('IT01', 'inbound-rtp', 'jitterBufferEmittedCount', jbe);
    put('OT01', 'outbound-rtp', 'kind', 'audio');
    put('OT01', 'outbound-rtp', 'codecId', 'COT01_0');
    put('OT01', 'outbound-rtp', 'packetsSent', tx);
    put('OT01', 'outbound-rtp', 'bytesSent', bytesOut);
    put('SA1', 'media-source', 'kind', 'audio');
    put('SA1', 'media-source', 'deviceLabel', o.deviceLabel ?? 'Jabra Evolve2 30');
    put('SA1', 'media-source', 'enabled', s.micEnabled ?? true);
    put('SA1', 'media-source', 'totalAudioEnergy', energyMic);
    put('SA1', 'media-source', 'totalSamplesDuration', durMic);
    put('RIA1', 'remote-inbound-rtp', 'kind', 'audio');
    put('RIA1', 'remote-inbound-rtp', 'localId', 'OT01');
    put('RIA1', 'remote-inbound-rtp', 'fractionLost', s.remoteLoss ?? 0);
    put('RIA1', 'remote-inbound-rtp', 'jitter', 0.002);
    put('RIA1', 'remote-inbound-rtp', 'roundTripTime', (s.rttMs ?? 40) / 1000);
    put('AP', 'media-playout', 'synthesizedSamplesDuration', synth);
    put('T01', 'transport', 'selectedCandidatePairId', 'CP1');
    put('T01', 'transport', 'dtlsState', 'connected');
    put('CP1', 'candidate-pair', 'localCandidateId', 'IL1');
    put('CP1', 'candidate-pair', 'remoteCandidateId', 'IR1');
    put('CP1', 'candidate-pair', 'currentRoundTripTime', (s.rttMs ?? 40) / 1000);
    put('CIT01_0', 'codec', 'mimeType', o.codec ?? 'audio/PCMU');
    put('CIT01_0', 'codec', 'clockRate', 8000);
    put('COT01_0', 'codec', 'mimeType', o.codec ?? 'audio/PCMU');
    put('COT01_0', 'codec', 'clockRate', 8000);
  }

  const stats: Record<string, unknown> = {};
  const start = ts[0];
  const end = ts.at(-1);
  for (const [id, { type, props }] of Object.entries(series)) {
    stats[`${id}-timestamp`] = { startTime: start, endTime: end, statsType: type, values: JSON.stringify(ts) };
    for (const [p, v] of Object.entries(props)) stats[`${id}-${p}`] = { startTime: start, endTime: end, statsType: type, values: JSON.stringify(v) };
  }
  const local = { address: '203.0.113.50', candidateType: 'prflx', protocol: 'udp', networkType: 'ethernet', ...o.local };
  for (const [k, v] of Object.entries(local)) stats[`IL1-${k}`] = { startTime: start, endTime: start, statsType: 'local-candidate', values: JSON.stringify([v]) };
  for (const [k, v] of Object.entries({ address: '198.51.100.20', candidateType: 'host', protocol: 'udp', isRemote: true }))
    stats[`IR1-${k}`] = { startTime: start, endTime: start, statsType: 'remote-candidate', values: JSON.stringify([v]) };

  const ev = (sec: number, type: string, value: string) => ({ time: clock(START + sec * 1000), type, value });
  const updateLog = [
    ev(1, 'setRemoteDescription', OFFER),
    ev(1, 'setLocalDescription', ANSWER),
    ev(1, 'iceconnectionstatechange', 'checking'),
    ev(2, 'iceconnectionstatechange', 'connected'),
    ev(2, 'connectionstatechange', 'connected'),
    ...(o.events ?? []).map(([s, t, v]) => ev(s, t, v)),
    ...(o.close === false ? [] : [ev(o.seconds + 2, 'close', '{}')]),
  ];

  return JSON.stringify({
    getUserMedia: [],
    PeerConnections: { pc1: { pid: 'pc1', url: 'https://space-demo.sprinklr.com/voice-debug-console-app/voice/conversation-analysis?caseNumber=1&conversationId=c1&participantId=p1', stats, updateLog } },
    UserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  });
}

/** Alternating conversation: far end talks on even 5-second blocks, agent on odd ones. */
export const talk = (i: number): SecondOpts => (Math.floor(i / 5) % 2 ? { micRms: 0.04, farRms: 0 } : { micRms: 0, farRms: 0.08 });

/**
 * A six-minute demo call with a handful of realistic problems, so the analyser can be tried
 * without a real dump: a Wi-Fi loss burst, a hold, a latency spike and outbound loss.
 */
export function demoDump(): string {
  return makeDump({
    seconds: 360,
    local: { networkType: 'wifi' },
    deviceLabel: 'Jabra Evolve2 30 SE',
    at: (i) => {
      const s = talk(i);
      if (i >= 90 && i < 130) return { ...s, loss: 0.07, conceal: 0.09, jitterMs: 45 + (i % 7) * 4 };
      if (i >= 180 && i < 250) return { micEnabled: false };
      if (i >= 270 && i < 285) return { ...s, rttMs: 380 };
      if (i >= 300 && i < 320) return { ...s, remoteLoss: 0.035 };
      return { ...s, jitterMs: 2 + (i % 5), rttMs: 38 + (i % 9) };
    },
  });
}
