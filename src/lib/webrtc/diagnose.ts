import { duration, elapsed, fixed } from './format';
import { AUDIBLE_RMS, mean, pctl, speechCodecs, type CallMetrics, type Sample } from './metrics';
import type { Dump } from './types';

export type Severity = 'critical' | 'warning' | 'info' | 'ok';
export type Category = 'Data' | 'Connection' | 'Network' | 'Audio' | 'Device' | 'Setup';

export interface Range {
  from: number;
  to: number;
}

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  detail: string;
  /** Measured values that back the finding. */
  evidence: string[];
  /** When it happened — drawn on the charts. */
  ranges: Range[];
}

export type ActivityState = 'both' | 'agent' | 'far' | 'silent';

export interface ActivitySpan extends Range {
  state: ActivityState;
  muted: boolean;
}

export interface Diagnosis {
  findings: Finding[];
  activity: ActivitySpan[];
  muted: Range[];
  hold: Range[];
  summary: {
    durationMs: number;
    connectedAt: number | null;
    setupMs: number | null;
    endedBy: string;
    mosIn: number | null;
    mosOut: number | null;
    mosInMin: number | null;
    talkMs: { agent: number; far: number; both: number; silent: number };
    counts: Record<Severity, number>;
  };
}

// Thresholds — kept together so the page can show them.
export const T = {
  lossWarn: 2,
  lossCrit: 5,
  jitterWarn: 30,
  jitterCrit: 50,
  rttWarn: 300,
  rttCrit: 500,
  bufferWarn: 300,
  concealWarn: 3,
  concealCrit: 8,
  glitchWarn: 50,
  mosPoor: 3.6,
  setupWarnMs: 3000,
  holdMinMs: 60_000,
  deadAirMinMs: 60_000,
};

/** Consecutive samples matching `test`, merged into time ranges. */
function runs(samples: Sample[], test: (s: Sample) => boolean): Range[] {
  const out: Range[] = [];
  let cur: Range | null = null;
  for (const s of samples) {
    if (test(s)) {
      if (cur && s.t0 - cur.to <= 1500) cur.to = s.t;
      else {
        cur = { from: s.t0, to: s.t };
        out.push(cur);
      }
    } else cur = null;
  }
  return out;
}

const len = (r: Range) => r.to - r.from;
const total = (rs: Range[]) => rs.reduce((a, r) => a + len(r), 0);

export function diagnose(dump: Dump, m: CallMetrics): Diagnosis {
  const f: Finding[] = [];
  const s = m.samples;
  const t0 = m.start ?? 0;
  const at = (t: number) => elapsed(t - t0);
  // A range that reaches the last sample ran until the data stopped — say so, rather than
  // printing a time that reads like the moment it ended.
  const lastT = s.at(-1)?.t ?? Infinity;
  const span = (r: Range) => `${at(r.from)}–${r.to >= lastT ? 'end of call' : at(r.to)} (${duration(len(r))})`;
  const list = (rs: Range[], max = 4) => rs.slice(0, max).map(span).join(', ') + (rs.length > max ? ` and ${rs.length - max} more` : '');
  const add = (x: Finding) => f.push(x);

  // ── Data ────────────────────────────────────────────────────────────────
  if (!m.hasStats) {
    add({
      id: 'no-stats',
      severity: 'critical',
      category: 'Data',
      title: 'This dump has no call data',
      detail:
        m.pc.events.length === 0
          ? 'There are no stats and no connection events for this participant. Usually the leg wasn’t a browser (WebRTC) call — a PSTN caller or SIP trunk — or nothing was captured. Export the agent’s participant instead.'
          : 'Connection events exist but no media stats were captured, so audio quality can’t be measured.',
      evidence: [`${m.pc.events.length} connection events`, '0 stats series'],
      ranges: [],
    });
  }
  if (m.cadenceMs && m.cadenceMs > 2000) {
    add({
      id: 'cadence',
      severity: 'info',
      category: 'Data',
      title: `Stats were sampled every ${Math.round(m.cadenceMs / 1000)} s`,
      detail: `Each point on the charts averages ${Math.round(m.cadenceMs / 1000)} seconds, so a glitch shorter than that can be smoothed away. Counters (loss, concealment) are still totalled exactly.`,
      evidence: [`${s.length} samples over ${duration(m.durationMs)}`],
      ranges: [],
    });
  }

  // ── Setup & connection ──────────────────────────────────────────────────
  for (const g of dump.getUserMedia.filter((g) => g.error)) {
    add({
      id: `gum-${g.t}`,
      severity: 'critical',
      category: 'Device',
      title: `Microphone request failed: ${g.error}`,
      detail:
        g.error === 'NotAllowedError'
          ? 'The browser blocked microphone access. Check the site permission and the OS privacy setting for the browser.'
          : g.error === 'NotFoundError'
            ? 'No microphone was found. Check the headset is plugged in and selected.'
            : g.error === 'NotReadableError'
              ? 'The microphone exists but couldn’t be opened — usually another app (Teams, Zoom) is holding it.'
              : g.errorMessage ?? 'The browser couldn’t open the microphone.',
      evidence: [g.errorMessage ?? g.error ?? ''],
      ranges: g.t ? [{ from: g.t, to: g.t }] : [],
    });
  }

  const conn = m.states.filter((x) => x.kind === 'Connection' || x.kind === 'ICE');
  const firstEvent = m.pc.events[0]?.t ?? null;
  const connected = conn.find((x) => x.state === 'connected' || x.state === 'completed');
  const setupMs = connected && firstEvent !== null ? connected.t - firstEvent : null;
  if (m.pc.events.length && !connected) {
    add({
      id: 'never-connected',
      severity: 'critical',
      category: 'Connection',
      title: 'The call never connected',
      detail: 'ICE never reached “connected”, so no audio could flow. This is almost always a firewall blocking UDP and no reachable TURN relay.',
      evidence: conn.map((x) => `${at(x.t)} ${x.kind} → ${x.state}`).slice(-6),
      ranges: [],
    });
  } else if (setupMs !== null && setupMs > T.setupWarnMs) {
    add({
      id: 'slow-setup',
      severity: 'warning',
      category: 'Connection',
      title: `Slow connection setup: ${(setupMs / 1000).toFixed(1)} s`,
      detail: 'The caller may have heard silence at the start of the call while the connection was negotiated.',
      evidence: [`first event → connected: ${(setupMs / 1000).toFixed(1)} s`],
      ranges: firstEvent && connected ? [{ from: firstEvent, to: connected.t }] : [],
    });
  }

  // Disconnects and recovery.
  const drops: Range[] = [];
  let downAt: number | null = null;
  for (const x of conn) {
    if ((x.state === 'disconnected' || x.state === 'failed') && downAt === null) downAt = x.t;
    if ((x.state === 'connected' || x.state === 'completed') && downAt !== null) {
      drops.push({ from: downAt, to: x.t });
      downAt = null;
    }
  }
  const failed = conn.some((x) => x.state === 'failed');
  if (drops.length) {
    add({
      id: 'reconnects',
      severity: 'warning',
      category: 'Connection',
      title: `Connection dropped and recovered ${drops.length} time${drops.length > 1 ? 's' : ''}`,
      detail: 'Audio cuts out completely while the connection is down. Usually Wi-Fi roaming, a VPN reconnecting, or a network change.',
      evidence: [list(drops)],
      ranges: drops,
    });
  }

  const last = m.pc.events.at(-1);
  const closeEvt = m.pc.events.find((e) => e.type === 'close');
  let endedBy = 'Unknown — the dump ends without a close event.';
  if (downAt !== null || failed) {
    endedBy = 'Dropped — the connection failed and never recovered.';
    add({
      id: 'dropped',
      severity: 'critical',
      category: 'Connection',
      title: 'The call dropped',
      detail: `The connection went ${failed ? 'into “failed”' : '“disconnected”'} at ${at(downAt ?? last?.t ?? t0)} and didn’t come back. The network path between the agent and the media server broke.`,
      evidence: conn.slice(-4).map((x) => `${at(x.t)} ${x.kind} → ${x.state}`),
      ranges: downAt ? [{ from: downAt, to: m.end ?? downAt }] : [],
    });
  } else if (closeEvt) {
    endedBy = `Closed normally by the app at ${at(closeEvt.t)} (hang-up or transfer).`;
  }

  // Renegotiations after the first offer/answer.
  const remoteOffers = m.negotiations.filter((n) => n.side === 'remote');
  const firstMedia = m.negotiations[0]?.sdp.media.find((x) => x.kind === 'audio');
  for (const n of m.negotiations.slice(2)) {
    const media = n.sdp.media.find((x) => x.kind === 'audio');
    if (!media || n.side !== 'remote') continue;
    const sinceStart = n.t - (m.negotiations[0]?.t ?? n.t);
    const minutes = sinceStart / 60_000;
    const sameCodecs =
      firstMedia &&
      speechCodecs(media).map((c) => c.name).sort().join() === speechCodecs(firstMedia).map((c) => c.name).sort().join();
    if (media.direction !== 'sendrecv') {
      const hold = media.direction === 'sendonly' || media.direction === 'inactive';
      add({
        id: `reneg-${n.t}`,
        severity: 'info',
        category: 'Connection',
        title: hold ? `Call put on hold at ${at(n.t)}` : `Media direction changed to ${media.direction} at ${at(n.t)}`,
        detail: `The media server re-offered with “${media.direction}”. ${hold ? 'That is a signalling hold — the agent stops receiving audio.' : ''}`,
        evidence: [`a=${media.direction}`],
        ranges: [{ from: n.t, to: n.t }],
      });
    } else if (sameCodecs && Math.abs(minutes - Math.round(minutes / 15) * 15) < 1 && minutes > 5) {
      add({
        id: `refresh-${n.t}`,
        severity: 'info',
        category: 'Connection',
        title: `Session refresh at ${at(n.t)} — not a fault`,
        detail: `The media server re-sent the same offer ${Math.round(minutes)} minutes in. That matches a SIP session timer keeping the call alive; nothing changed.`,
        evidence: [`same codecs, ${media.direction}, ${Math.round(minutes)} min after setup`],
        ranges: [{ from: n.t, to: n.t }],
      });
    } else {
      add({
        id: `reneg-${n.t}`,
        severity: 'info',
        category: 'Connection',
        title: `Renegotiated at ${at(n.t)}`,
        detail: 'The media session was renegotiated mid-call — typically a transfer, conference, or hold/resume handled by the server.',
        evidence: [`codecs offered: ${speechCodecs(media).map((c) => c.name).join(', ')}`],
        ranges: [{ from: n.t, to: n.t }],
      });
    }
  }

  // ── Network path ────────────────────────────────────────────────────────
  if (m.local) {
    const type = m.local.candidateType;
    const relayed = type === 'relay';
    const proto = m.local.relayProtocol ?? m.local.protocol;
    if (relayed && proto && proto !== 'udp') {
      add({
        id: 'turn-tcp',
        severity: 'warning',
        category: 'Network',
        title: `Audio was relayed over TURN/${proto.toUpperCase()}`,
        detail: 'UDP was blocked, so audio was tunnelled over TCP/TLS through a relay. That adds latency and turns any packet loss into stalls. Ask IT to allow outbound UDP to the media servers.',
        evidence: [`local candidate: relay (${proto})`],
        ranges: [],
      });
    } else if (relayed) {
      add({
        id: 'turn-udp',
        severity: 'info',
        category: 'Network',
        title: 'Audio went through a TURN relay (UDP)',
        detail: 'A direct path wasn’t possible, so a relay was used. Works fine, with slightly more latency.',
        evidence: ['local candidate: relay (udp)'],
        ranges: [],
      });
    } else {
      add({
        id: 'direct',
        severity: 'ok',
        category: 'Network',
        title: `Direct ${(m.local.protocol ?? 'udp').toUpperCase()} path to the media server`,
        detail: type === 'host' ? 'No NAT or relay in the way.' : 'Through the office/home NAT, with no relay — the best case for a browser call.',
        evidence: [`local candidate: ${type}`, `remote candidate: ${m.remote?.candidateType ?? '—'}`],
        ranges: [],
      });
    }
    const net = m.local.networkType;
    if (net === 'vpn') {
      add({ id: 'vpn', severity: 'warning', category: 'Network', title: 'Audio went over a VPN', detail: 'VPN tunnels add latency and often reorder or drop packets. Split-tunnelling the media servers usually fixes voice quality.', evidence: ['networkType: vpn'], ranges: [] });
    } else if (net === 'wifi') {
      add({ id: 'wifi', severity: 'info', category: 'Network', title: 'Agent was on Wi-Fi', detail: 'Wi-Fi is the most common cause of bursty loss and jitter. Wired Ethernet is more reliable for voice.', evidence: ['networkType: wifi'], ranges: [] });
    } else if (net === 'cellular') {
      add({ id: 'cellular', severity: 'warning', category: 'Network', title: 'Agent was on a mobile data connection', detail: 'Cellular links vary in latency and loss.', evidence: ['networkType: cellular'], ranges: [] });
    }
  }
  if (m.pairSwitches.length) {
    add({
      id: 'pair-switch',
      severity: 'warning',
      category: 'Network',
      title: `Network path changed ${m.pairSwitches.length} time${m.pairSwitches.length > 1 ? 's' : ''} mid-call`,
      detail: 'The connection moved to a different network path — a Wi-Fi/Ethernet switch or VPN change. Expect a short audio gap at each switch.',
      evidence: m.pairSwitches.map((p) => at(p.t)),
      ranges: m.pairSwitches.map((p) => ({ from: p.t, to: p.t })),
    });
  }
  const lowBw = runs(s, (x) => x.availableOutKbps !== null && x.availableOutKbps < 100);
  if (lowBw.length) {
    add({ id: 'low-bw', severity: 'warning', category: 'Network', title: 'Very little upload bandwidth', detail: 'The browser estimated under 100 kbps of upload available, which leaves little headroom for voice.', evidence: [list(lowBw)], ranges: lowBw });
  }

  // ── Network quality, both directions ────────────────────────────────────
  type Dir = { key: 'in' | 'out'; who: string; hears: string };
  const dirs: Dir[] = [
    { key: 'in', who: 'far end → agent', hears: 'what the agent heard' },
    { key: 'out', who: 'agent → far end', hears: 'what the far end heard from the agent' },
  ];
  for (const d of dirs) {
    const loss = (x: Sample) => (d.key === 'in' ? x.inLossPct : x.remoteLossPct);
    const jit = (x: Sample) => (d.key === 'in' ? x.inJitterMs : x.remoteJitterMs);
    const lossVals = s.map(loss);
    if (lossVals.every((v) => v === null)) continue;

    const bad = runs(s, (x) => (loss(x) ?? 0) >= T.lossWarn);
    const worst = Math.max(...lossVals.map((v) => v ?? 0));
    const overall = d.key === 'in' && m.totals.packetsReceived ? (100 * (m.totals.packetsLost ?? 0)) / (m.totals.packetsReceived + (m.totals.packetsLost ?? 0)) : mean(lossVals, s.map((x) => x.dt));
    if (bad.length) {
      add({
        id: `loss-${d.key}`,
        severity: worst >= T.lossCrit || (overall ?? 0) >= 3 ? 'critical' : 'warning',
        category: 'Network',
        title: `Packet loss on ${d.hears}`,
        detail: `Audio packets from ${d.who} went missing. Above ~${T.lossWarn}% it sounds choppy; above ~${T.lossCrit}% words drop out.`,
        evidence: [`worst ${fixed(worst)}%, overall ${fixed(overall, 2)}%`, `affected: ${list(bad)}`],
        ranges: bad,
      });
    }

    const jVals = s.map(jit);
    const jBad = runs(s, (x) => (jit(x) ?? 0) >= T.jitterWarn);
    const jWorst = Math.max(...jVals.map((v) => v ?? 0));
    if (jBad.length) {
      add({
        id: `jitter-${d.key}`,
        severity: jWorst >= T.jitterCrit ? 'critical' : 'warning',
        category: 'Network',
        title: `High jitter on ${d.hears}`,
        detail: 'Packets arrived unevenly. The receiver has to buffer more (adding delay) or drop late packets (adding choppiness).',
        evidence: [`worst ${fixed(jWorst, 0)} ms`, `affected: ${list(jBad)}`],
        ranges: jBad,
      });
    }
    if (!bad.length && !jBad.length) {
      add({
        id: `clean-${d.key}`,
        severity: 'ok',
        category: 'Network',
        title: `No loss or jitter problems on ${d.hears}`,
        detail: `${d.who}: loss stayed under ${T.lossWarn}% and jitter under ${T.jitterWarn} ms for the whole call.`,
        evidence: [`overall loss ${fixed(overall, 3)}%`, `jitter p95 ${fixed(pctl(jVals, 0.95), 0)} ms`],
        ranges: [],
      });
    }
  }

  const rtt = s.map((x) => x.rttMs);
  const rttBad = runs(s, (x) => (x.rttMs ?? 0) >= T.rttWarn);
  if (rttBad.length) {
    const worst = Math.max(...rtt.map((v) => v ?? 0));
    add({
      id: 'rtt',
      severity: worst >= T.rttCrit ? 'critical' : 'warning',
      category: 'Network',
      title: 'High latency',
      detail: `Round trip over ${T.rttWarn} ms makes people talk over each other and wait for replies.`,
      evidence: [`worst ${fixed(worst, 0)} ms`, `affected: ${list(rttBad)}`],
      ranges: rttBad,
    });
  } else if (rtt.some((v) => v !== null)) {
    add({ id: 'rtt-ok', severity: 'ok', category: 'Network', title: 'Latency was fine', detail: `Round trip to the media server stayed under ${T.rttWarn} ms.`, evidence: [`median ${fixed(pctl(rtt, 0.5), 0)} ms, worst ${fixed(Math.max(...rtt.map((v) => v ?? 0)), 0)} ms`], ranges: [] });
  }

  // ── Audio ───────────────────────────────────────────────────────────────
  const concBad = runs(s, (x) => (x.concealPct ?? 0) >= T.concealWarn);
  if (concBad.length) {
    const worst = Math.max(...s.map((x) => x.concealPct ?? 0));
    add({
      id: 'conceal',
      severity: worst >= T.concealCrit ? 'critical' : 'warning',
      category: 'Audio',
      title: 'Robotic / choppy audio heard by the agent',
      detail: 'The browser had to invent audio to cover missing or late packets (“concealment”). This is what people describe as robotic, metallic or breaking up.',
      evidence: [`worst ${fixed(worst)}% of audio concealed`, `affected: ${list(concBad)}`],
      ranges: concBad,
    });
  }
  const bufBad = runs(s, (x) => (x.jitterBufferMs ?? 0) >= T.bufferWarn);
  if (bufBad.length) {
    add({ id: 'buffer', severity: 'warning', category: 'Audio', title: 'Large receive buffer added delay', detail: `To ride out uneven packets the browser held audio for over ${T.bufferWarn} ms before playing it.`, evidence: [`worst ${fixed(Math.max(...s.map((x) => x.jitterBufferMs ?? 0)), 0)} ms`, `affected: ${list(bufBad)}`], ranges: bufBad });
  }
  const glitch = runs(s, (x) => (x.playoutGlitchMs ?? 0) >= T.glitchWarn);
  if (glitch.length) {
    add({ id: 'playout', severity: 'warning', category: 'Device', title: 'Crackles from the agent’s audio output', detail: 'The headset/speaker wasn’t fed audio in time. This is a local problem — CPU load, a USB/Bluetooth hiccup or audio driver — not the network.', evidence: [`${fixed(Math.max(...s.map((x) => x.playoutGlitchMs ?? 0)), 0)} ms worst window`, `affected: ${list(glitch)}`], ranges: glitch });
  }

  // Packets stop flowing entirely.
  const inStall = runs(s, (x) => x.inPps !== null && x.inPps < 1);
  if (inStall.length && total(inStall) >= 2000) {
    add({ id: 'in-stall', severity: 'critical', category: 'Audio', title: 'Agent received no audio packets', detail: 'Nothing arrived from the far end — the agent would have heard silence. Points at the media server, a firewall closing the UDP flow, or a hold.', evidence: [list(inStall)], ranges: inStall });
  }
  const outStall = runs(s, (x) => x.outPps !== null && x.outPps < 1);
  if (outStall.length && total(outStall) >= 2000) {
    add({ id: 'out-stall', severity: 'critical', category: 'Audio', title: 'Agent sent no audio packets', detail: 'The browser stopped transmitting — the far end would have heard silence.', evidence: [list(outStall)], ranges: outStall });
  }

  // Who was audible, mute periods, hold and dead air.
  const muted = runs(s, (x) => x.micEnabled === false);
  const farOn = (x: Sample) => (x.farRms ?? 0) >= AUDIBLE_RMS;
  const micOn = (x: Sample) => x.micEnabled !== false && (x.micRms ?? 0) >= AUDIBLE_RMS;
  const activity: ActivitySpan[] = [];
  for (const x of s) {
    const state: ActivityState = farOn(x) && micOn(x) ? 'both' : micOn(x) ? 'agent' : farOn(x) ? 'far' : 'silent';
    const mutedNow = x.micEnabled === false;
    const prev = activity.at(-1);
    if (prev && prev.state === state && prev.muted === mutedNow && x.t0 - prev.to <= 1500) prev.to = x.t;
    else activity.push({ from: x.t0, to: x.t, state, muted: mutedNow });
  }
  const talk = { agent: 0, far: 0, both: 0, silent: 0 };
  for (const a of activity) talk[a.state] += len(a);

  const hold = runs(s, (x) => x.micEnabled === false && !farOn(x)).filter((r) => len(r) >= T.holdMinMs);
  if (hold.length) {
    add({
      id: 'hold',
      severity: 'info',
      category: 'Audio',
      title: `Looks like hold: ${duration(total(hold))} with the agent muted and the far end silent`,
      detail: 'Audio packets kept flowing but carried silence, and the agent’s mic was switched off. That’s the signature of a hold (or a long mute). If the customer says they were talking during this time, treat it as one-way audio instead.',
      evidence: [list(hold)],
      ranges: hold,
    });
  }
  const deadAir = runs(s, (x) => x.micEnabled !== false && !farOn(x) && !micOn(x)).filter((r) => len(r) >= T.deadAirMinMs);
  if (deadAir.length) {
    add({ id: 'dead-air', severity: 'warning', category: 'Audio', title: `Dead air: ${duration(total(deadAir))} of silence on both sides`, detail: 'The agent was unmuted but neither side made a sound. Either a silent wait, or audio that wasn’t getting through in either direction.', evidence: [list(deadAir)], ranges: deadAir });
  }
  // A single sample that straddles the moment of muting isn't evidence; ask for 1.5 samples' worth.
  const minOverlap = Math.max(4000, 1.5 * (m.cadenceMs ?? 1000));
  const farWhileMuted = runs(s, (x) => x.micEnabled === false && farOn(x)).filter((r) => len(r) >= minOverlap);
  if (farWhileMuted.length) {
    add({ id: 'far-while-muted', severity: 'warning', category: 'Audio', title: 'Far end spoke while the agent was muted', detail: 'If the customer was waiting for a reply here, they heard nothing back.', evidence: [list(farWhileMuted)], ranges: farWhileMuted });
  }
  if (muted.length) {
    add({ id: 'muted', severity: 'info', category: 'Audio', title: `Agent mic muted ${muted.length} time${muted.length > 1 ? 's' : ''} — ${duration(total(muted))} in total`, detail: 'The microphone track was disabled (mute or hold button).', evidence: [list(muted, 6)], ranges: muted });
  }

  const unmutedMs = s.filter((x) => x.micEnabled !== false && x.micRms !== null).reduce((a, x) => a + x.dt * 1000, 0);
  const micHeard = s.some(micOn);
  if (unmutedMs >= 30_000 && !micHeard) {
    add({ id: 'mic-dead', severity: 'critical', category: 'Device', title: 'Agent’s microphone picked up no sound', detail: 'The mic was on, but captured silence for the whole call — wrong input device, a hardware mute switch, or an OS-level mute. The far end would have heard nothing from the agent.', evidence: [`${duration(unmutedMs)} unmuted with zero mic level`], ranges: [] });
  }
  const farHeardMs = s.filter(farOn).reduce((a, x) => a + x.dt * 1000, 0);
  if (m.durationMs >= 30_000 && (m.totals.packetsReceived ?? 0) > 0 && farHeardMs === 0 && s.some((x) => x.farRms !== null)) {
    add({ id: 'far-silent', severity: 'critical', category: 'Audio', title: 'Far-end audio arrived but was silent all call', detail: 'Packets kept arriving, but every one carried silence. Either the customer never spoke, or their audio was lost before it reached the media server (carrier or PSTN leg) — classic one-way audio.', evidence: [`${m.totals.packetsReceived} packets received, peak level 0`], ranges: [] });
  }

  // ── Codec & device ──────────────────────────────────────────────────────
  if (m.codecIn) {
    const offered = remoteOffers[0]?.sdp.media.find((x) => x.kind === 'audio');
    const hadOpus = offered && speechCodecs(offered).some((c) => /opus/i.test(c.name));
    if (!m.codecIn.wideband) {
      add({
        id: 'narrowband',
        severity: 'info',
        category: 'Setup',
        title: `Narrowband codec: ${m.codecIn.name} (${m.codecIn.clockRate / 1000} kHz)`,
        detail: `Telephone-quality audio with no built-in loss protection.${hadOpus ? ' Opus was offered but the media server preferred this. Normal for PSTN callers; on browser-to-browser legs Opus would sound better and handle loss better.' : ' Normal when the caller is on the phone network.'}`,
        evidence: [`negotiated ${m.codecIn.mimeType}`, ...(offered ? [`offered: ${speechCodecs(offered).map((c) => c.name).join(', ')}`] : [])],
        ranges: [],
      });
    } else {
      add({ id: 'wideband', severity: 'ok', category: 'Setup', title: `Wideband codec: ${m.codecIn.name}`, detail: 'HD voice with loss protection.', evidence: [`negotiated ${m.codecIn.mimeType}`], ranges: [] });
    }
  }
  const label = m.deviceLabels.at(-1)?.label ?? '';
  if (/bluetooth|airpods|hands-?free|\bbt\b|buds/i.test(label)) {
    add({ id: 'bluetooth', severity: 'warning', category: 'Device', title: 'Bluetooth headset microphone', detail: 'Bluetooth mics switch to a low-quality “hands-free” mode during calls and add latency and dropouts. A USB or wired headset is more reliable.', evidence: [label], ranges: [] });
  } else if (/macbook|built-?in|internal|realtek|default/i.test(label)) {
    add({ id: 'builtin-mic', severity: 'info', category: 'Device', title: 'Built-in or default microphone', detail: 'Laptop mics pick up room noise and speaker audio (echo risk). A headset gives cleaner audio.', evidence: [label], ranges: [] });
  } else if (label) {
    add({ id: 'device', severity: 'ok', category: 'Device', title: `Headset: ${label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')}`, detail: 'A dedicated headset microphone.', evidence: [label], ranges: [] });
  }
  if (m.deviceLabels.length > 1) {
    add({ id: 'device-change', severity: 'warning', category: 'Device', title: 'Microphone changed mid-call', detail: 'The input device switched during the call (headset unplugged, Bluetooth reconnect, or OS default changed).', evidence: m.deviceLabels.map((d) => `${at(d.t)} ${d.label}`), ranges: m.deviceLabels.slice(1).map((d) => ({ from: d.t, to: d.t })) });
  }
  if (dump.browser.name === 'Other') {
    add({ id: 'browser', severity: 'info', category: 'Setup', title: 'Not a Chromium browser', detail: 'These stats are best supported in Chrome and Edge.', evidence: [dump.userAgent ?? ''], ranges: [] });
  }

  // ── Overall quality ─────────────────────────────────────────────────────
  const w = s.map((x) => x.dt);
  const mosInVals = s.map((x) => x.mosIn);
  const poor = runs(s, (x) => x.mosIn !== null && x.mosIn < T.mosPoor);
  if (poor.length && total(poor) >= 10_000) {
    add({ id: 'mos', severity: 'warning', category: 'Audio', title: `Estimated quality was poor for ${duration(total(poor))}`, detail: `Estimated MOS dropped below ${T.mosPoor}, where most listeners notice degraded audio.`, evidence: [list(poor)], ranges: poor });
  }

  const order: Severity[] = ['critical', 'warning', 'info', 'ok'];
  f.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const counts = { critical: 0, warning: 0, info: 0, ok: 0 } as Record<Severity, number>;
  for (const x of f) counts[x.severity]++;

  return {
    findings: f,
    activity,
    muted,
    hold,
    summary: {
      durationMs: m.durationMs,
      connectedAt: connected?.t ?? null,
      setupMs,
      endedBy,
      mosIn: mean(mosInVals, w),
      mosOut: mean(s.map((x) => x.mosOut), w),
      mosInMin: pctl(mosInVals, 0),
      talkMs: talk,
      counts,
    },
  };
}
