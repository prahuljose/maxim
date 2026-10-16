import type { AiReply } from '../../lib/webrtc/ai';
import { T, type Diagnosis, type Finding, type Severity } from '../../lib/webrtc/diagnose';
import { duration, elapsed, fixed, maskIp, maskIpsInText } from '../../lib/webrtc/format';
import { pctl, type CallMetrics } from '../../lib/webrtc/metrics';
import { speechCodecs } from '../../lib/webrtc/sdp';
import type { Dump, PeerConnection } from '../../lib/webrtc/types';
import type { Verdict } from '../../lib/webrtc/verdict';
import { esc } from './chart';

export interface ViewCtx {
  dump: Dump;
  m: CallMetrics;
  d: Diagnosis;
  showIps: boolean;
  fileName: string;
}

const ip = (c: ViewCtx, v: string | null | undefined) => esc(c.showIps ? (v ?? '—') : maskIp(v));
const txt = (c: ViewCtx, v: string) => esc(c.showIps ? v : maskIpsInText(v));
const at = (c: ViewCtx, t: number) => elapsed(t - (c.m.start ?? 0));
// Event times are often whole seconds, so sub-second setup reads as 0.
const setup = (ms: number) => (ms < 1000 ? 'under 1 s' : `${fixed(ms / 1000, 1)} s`);
const int = new Intl.NumberFormat();

const SEV_LABEL: Record<Severity, string> = { critical: 'Problem', warning: 'Warning', info: 'Note', ok: 'Passed' };
const CHEVRON = '<svg class="chev" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function header(c: ViewCtx): string {
  const s = c.m.pc.sprinklr;
  const when = c.m.start ? new Date(c.m.start) : null;
  const date = when ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(when) : null;
  const meta = [
    date,
    duration(c.m.durationMs),
    s?.caseNumber ? `Case ${s.caseNumber}` : null,
    `${c.dump.browser.name} ${c.dump.browser.version ?? ''}`.trim(),
  ].filter(Boolean);
  return `
    <h1 id="rep-title" tabindex="-1">${s ? 'Sprinklr Voice Call' : 'WebRTC Call'}</h1>
    <p class="rep-meta">${meta.map((x) => `<span>${esc(x)}</span>`).join('')}<span class="mono" translate="no" title="${esc(c.fileName)}">${esc(shorten(c.fileName, 36))}</span></p>`;
}

function shorten(v: string, n: number) {
  return v.length > n ? `${v.slice(0, n - 12)}…${v.slice(-10)}` : v;
}

export const STATUS: Record<Verdict['status'], { label: string; tone: 'red' | 'amber' | 'green' | 'blue' }> = {
  confirmed: { label: 'Confirmed', tone: 'red' },
  likely: { label: 'Likely', tone: 'amber' },
  review: { label: 'Worth a look', tone: 'amber' },
  'not-found': { label: 'Not found in this call', tone: 'green' },
  'not-visible': { label: 'Can’t be measured', tone: 'blue' },
  none: { label: 'All clear', tone: 'green' },
};

export function verdictBody(v: Verdict): string {
  const s = STATUS[v.status];
  return `
    <div class="v-head"><span class="badge ${s.tone}">${esc(s.label)}</span><h2>${esc(v.headline)}</h2></div>
    ${v.reasons.length ? `<ul class="v-reasons">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${v.nextSteps.length ? `<p class="v-next-title">Next steps</p><ol class="v-next">${v.nextSteps.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>` : ''}`;
}

export function scorecards(c: ViewCtx): string {
  const { m, d } = c;
  const s = m.samples;
  // A number's colour follows its finding, so a 40-second burst isn't hidden by a calm average.
  const tone = (v: number | null, ...ids: string[]) => {
    if (v === null) return '';
    const hit = d.findings.filter((f) => ids.includes(f.id));
    return hit.some((f) => f.severity === 'critical') ? 'critical' : hit.some((f) => f.severity === 'warning') ? 'warning' : 'ok';
  };
  const worstLoss = Math.max(0, ...s.map((x) => x.inLossPct ?? 0));
  const mos = d.summary.mosIn;
  const loss = m.totals.packetsReceived ? (100 * (m.totals.packetsLost ?? 0)) / (m.totals.packetsReceived + (m.totals.packetsLost ?? 0)) : null;
  const jit = pctl(s.map((x) => x.inJitterMs), 0.95);
  const rtt = pctl(s.map((x) => x.rttMs), 0.5);
  const worstRtt = Math.max(0, ...s.map((x) => x.rttMs ?? 0));
  const t = d.summary.talkMs;
  const all = t.agent + t.far + t.both + t.silent || 1;
  const seg = (ms: number, color: string, label: string) => (ms ? `<i style="width:${(100 * ms) / all}%;background:${color}" title="${esc(`${label}: ${duration(ms)}`)}"></i>` : '');
  return `
    <div class="stats">
      <div class="stat"><p class="k">Call quality</p><p class="v ${tone(mos, 'mos', 'conceal')}">${fixed(mos, 1)}<span class="small muted"> / 4.4</span></p><p class="s">Estimated MOS · worst ${fixed(d.summary.mosInMin, 1)}</p></div>
      <div class="stat"><p class="k">Packet loss</p><p class="v ${tone(loss, 'loss-in', 'loss-out')}">${fixed(loss, loss !== null && loss < 0.1 ? 2 : 1, '%')}</p><p class="s">Overall · worst ${fixed(worstLoss, worstLoss < 0.1 ? 2 : 1, '%')}</p></div>
      <div class="stat"><p class="k">Jitter</p><p class="v ${tone(jit, 'jitter-in', 'jitter-out')}">${fixed(jit, 0, ' ms')}</p><p class="s">95th percentile</p></div>
      <div class="stat"><p class="k">Latency</p><p class="v ${tone(rtt, 'rtt', 'buffer')}">${fixed(rtt, 0, ' ms')}</p><p class="s">Typical round trip · worst ${fixed(worstRtt, 0, ' ms')}</p></div>
    </div>
    <div class="talk">
      <span class="talk-label">Who was audible</span>
      <span class="talkbar" role="img" aria-label="${esc(`Agent ${duration(t.agent)}, far end ${duration(t.far)}, both ${duration(t.both)}, neither ${duration(t.silent)}`)}">${seg(t.agent, 'var(--s1)', 'Agent')}${seg(t.both, 'color-mix(in srgb, var(--s1) 50%, var(--s2))', 'Both')}${seg(t.far, 'var(--s2)', 'Far end')}</span>
      <span class="legend"><span><i class="sw s1"></i>Agent ${duration(t.agent)}</span><span><i class="sw s2"></i>Far end ${duration(t.far)}</span><span>Neither ${duration(t.silent)}</span></span>
    </div>
    <p class="small muted" style="margin:8px 0 0">${esc(d.summary.endedBy)}${d.summary.setupMs !== null ? ` Connected in ${setup(d.summary.setupMs)}.` : ''}</p>`;
}

export function findingsList(c: ViewCtx): string {
  const order: Severity[] = ['critical', 'warning', 'info'];
  const index = new Map(c.d.findings.map((f, i) => [f, i]));
  const open = c.d.findings.filter((f) => f.severity !== 'ok');
  const passed = c.d.findings.filter((f) => f.severity === 'ok');
  const row = (f: Finding) => {
    const i = index.get(f)!;
    return `
      <details class="finding" data-finding="${i}">
        <summary><span class="sev ${f.severity}" aria-hidden="true"></span><span class="f-title">${txt(c, f.title)}</span><span class="f-cat">${SEV_LABEL[f.severity]} · ${esc(f.category)}</span>${CHEVRON}</summary>
        <div class="f-body">
          <p>${txt(c, f.detail)}</p>
          ${f.evidence.length ? `<ul class="evidence">${f.evidence.map((e) => `<li>${txt(c, e)}</li>`).join('')}</ul>` : ''}
          ${f.ranges.length ? `<button type="button" class="btn" data-show="${i}" aria-pressed="false">Show on Charts</button>` : ''}
        </div>
      </details>`;
  };
  const rows = order.flatMap((sev) => open.filter((f) => f.severity === sev)).map(row).join('');
  const pass = passed.length
    ? `<details class="finding passed">
        <summary><span class="sev ok" aria-hidden="true"></span><span class="f-title">${passed.length} check${passed.length > 1 ? 's' : ''} passed</span>${CHEVRON}</summary>
        <div class="f-body"><ul>${passed.map((f) => `<li><span>${txt(c, f.title)}</span><span>${txt(c, f.evidence[0] ?? '')}</span></li>`).join('')}</ul></div>
      </details>`
    : '';
  const none = !open.length ? '<div class="finding"><p class="f-body" style="padding:14px 16px">No problems found.</p></div>' : '';
  return `<div class="findings">${rows}${none}${pass}</div>`;
}

export function connection(c: ViewCtx): string {
  const { m } = c;
  const l = m.local;
  const r = m.remote;
  const nat = l?.relatedAddress && l.candidateType !== 'host';
  const relay = l?.candidateType === 'relay';
  const node = (title: string, lines: string[]) => `<div class="node"><strong>${esc(title)}</strong>${lines.map((x) => `<span>${x}</span>`).join('')}</div>`;
  const hop = `<span class="hop" aria-hidden="true">→ ${esc((l?.protocol ?? 'udp').toUpperCase())} →</span>`;
  const path = l
    ? `<div class="path">
        ${node('Agent PC', [`<span class="mono">${nat ? ip(c, l.relatedAddress) : ip(c, l.address)}</span>`, esc(l.networkType ?? 'network unknown')])}
        ${hop}
        ${nat ? `${node(relay ? 'TURN relay' : 'NAT / firewall', [`<span class="mono">${ip(c, l.address)}</span>`, esc(relay ? `relay over ${l.relayProtocol ?? l.protocol}` : `public address (${l.candidateType})`)])}${hop}` : ''}
        ${node(m.pc.sprinklr ? 'Sprinklr media server' : 'Remote peer', [`<span class="mono">${ip(c, r?.address)}</span>`, esc(r ? `${r.candidateType} · port ${r.port ?? '—'}` : '—')])}
      </div>`
    : '<p class="muted">No selected candidate pair in this dump.</p>';
  const inUse = (id: string) => id === l?.id || id === r?.id;
  const rows = m.candidates
    .map((x) => `<tr class="${inUse(x.id) ? 'chosen' : ''}"><td>${x.isRemote ? 'Remote' : 'Local'}</td><td>${esc(x.candidateType ?? '—')}</td><td>${esc(x.protocol ?? '—')}${x.relayProtocol ? ` / ${esc(x.relayProtocol)}` : ''}</td><td class="mono">${ip(c, x.address)}${x.port ? `:${x.port}` : ''}</td><td>${esc(x.networkType ?? '—')}</td><td>${inUse(x.id) ? 'In use' : ''}</td></tr>`)
    .join('');
  return `
    ${path}
    <div class="tbl"><table><thead><tr><th>Side</th><th>Type</th><th>Protocol</th><th>Address</th><th>Network</th><th><span class="sr">Status</span></th></tr></thead><tbody>${rows || '<tr><td colspan="6">No candidates recorded.</td></tr>'}</tbody></table></div>
    <dl class="kv">
      <div><dt>Encryption</dt><dd>${esc(m.security.srtpCipher ?? '—')}</dd></div>
      <div><dt>DTLS</dt><dd>${esc(m.security.dtlsCipher ?? '—')}</dd></div>
      <div><dt>Path changes</dt><dd>${m.pairSwitches.length}</dd></div>
      <div><dt>Connected in</dt><dd>${c.d.summary.setupMs !== null ? setup(c.d.summary.setupMs) : '—'}</dd></div>
    </dl>`;
}

export function negotiations(c: ViewCtx): string {
  if (!c.m.negotiations.length) return '<p class="muted">No offer/answer exchanges recorded.</p>';
  return `<ol class="negs">${c.m.negotiations
    .map((n) => {
      const a = n.sdp.media.find((x) => x.kind === 'audio');
      const codecs = a ? speechCodecs(a).map((x) => esc(x.name)).join(', ') : '—';
      const origin = n.sdp.origin?.split(' ')[0];
      return `<li>
        <div class="neg-top"><span class="mono">${at(c, n.t)}</span><strong>${n.side === 'remote' ? 'Offer from media server' : 'Answer from browser'}</strong><span class="badge">${esc(a?.direction ?? '—')}</span></div>
        <p class="muted">Codecs, in order of preference: ${codecs}${origin && origin !== '-' ? ` · ${txt(c, origin)}` : ''}</p>
        <details><summary>Raw SDP</summary><pre translate="no">${txt(c, n.raw)}</pre></details>
      </li>`;
    })
    .join('')}</ol>`;
}

export function device(c: ViewCtx): string {
  const { m, dump } = c;
  const gum = dump.getUserMedia;
  return `
    <dl class="kv">
      <div><dt>Microphone</dt><dd>${esc(m.deviceLabels.at(-1)?.label ?? '—')}</dd></div>
      <div><dt>Browser</dt><dd>${esc(`${dump.browser.name} ${dump.browser.version ?? ''}`)} · ${esc(dump.browser.os ?? '—')}</dd></div>
      <div><dt>Codec</dt><dd>${esc(m.codecIn ? `${m.codecIn.name} · ${m.codecIn.clockRate / 1000} kHz · ${m.codecIn.wideband ? 'wideband' : 'narrowband'}` : '—')}</dd></div>
      <div><dt>Echo return loss</dt><dd class="num">${fixed(m.echo.erl, 1, ' dB')}</dd></div>
      <div><dt>Echo cancellation gain</dt><dd class="num">${fixed(m.echo.erle, 1, ' dB')}</dd></div>
    </dl>
    <p class="mono small muted" translate="no">${esc(dump.userAgent ?? '')}</p>
    ${
      gum.length
        ? `<div class="tbl"><table><thead><tr><th>Microphone request</th><th>Constraints</th><th>Result</th></tr></thead><tbody>${gum
            .map((g) => `<tr><td>${esc(g.origin ?? '—')}</td><td class="mono small">${esc(g.audio ?? '—')}</td><td>${g.error ? `<span class="badge red">${esc(g.error)}</span>` : 'OK'}</td></tr>`)
            .join('')}</tbody></table></div>`
        : '<p class="muted small">This dump doesn’t include microphone-request records.</p>'
    }`;
}

export function totals(c: ViewCtx): string {
  const t = c.m.totals;
  const n = (v: number | null) => (v === null ? '—' : int.format(v));
  const ms = (v: number | null) => (v === null ? '—' : duration(v));
  const rows: [string, string, string][] = [
    ['Packets received', n(t.packetsReceived), 'From the far end'],
    ['Packets lost', n(t.packetsLost), 'Never arrived'],
    ['Packets sent', n(t.packetsSent), 'From the agent'],
    ['Audio received', ms(t.audioMs), 'Total audio played out'],
    ['Audio concealed', ms(t.concealedMs), 'Filled in to cover gaps (not counting silence)'],
    ['Sped up', ms(t.accelerateMs), 'Played faster to shrink a grown buffer'],
    ['Slowed down', ms(t.decelerateMs), 'Stretched while waiting for packets'],
    ['FEC packets', n(t.fecRecovered), 'Redundant packets for loss recovery'],
    ['NACKs', n(t.nackCount), 'Retransmission requests'],
    ['Retransmitted', n(t.retransmitted), 'Packets sent again'],
  ];
  return `<div class="tbl"><table><tbody>${rows.map(([a, b, cc]) => `<tr><th scope="row">${a}</th><td class="n">${b}</td><td class="muted">${cc}</td></tr>`).join('')}</tbody></table></div>`;
}

export function eventLog(c: ViewCtx, pc: PeerConnection, filter: string): string {
  const evs = pc.events.filter((e) => !filter || e.type === filter);
  if (!evs.length) return '<p class="muted">No events.</p>';
  return `<div class="tbl log"><table><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>${evs
    .map((e) => {
      const short = e.value.replace(/\s+/g, ' ').slice(0, 110);
      const long = e.value.length > 110;
      return `<tr><td class="mono">${at(c, e.t)}</td><td translate="no">${esc(e.type)}</td><td>${long ? `<details><summary class="mono small">${txt(c, short)}…</summary><pre translate="no">${txt(c, e.value)}</pre></details>` : `<span class="mono small">${txt(c, short)}</span>`}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

export function aiCard(r: AiReply): string {
  const conf = (x: string) => `<span class="badge violet">${esc(x)} confidence</span>`;
  return `
    <div class="ai-card" role="region" aria-label="AI second opinion">
      <span class="badge violet">AI opinion · not measured · verify before acting</span>
      ${r.verdict ? `<h3>${esc(r.verdict)}</h3>` : ''}
      ${r.rootCause.title ? `<p><strong>Likely cause:</strong> ${esc(r.rootCause.title)} ${conf(r.rootCause.confidence)}</p><p class="muted">${esc(r.rootCause.explanation)}</p>` : ''}
      <p class="small muted">${r.agreesWithAnalyser ? 'The AI agrees with the measured findings.' : 'The AI doesn’t fully agree with the measured findings. Compare its reasoning with the evidence above.'}</p>
      ${r.hypotheses.length ? `<h4>Hypotheses</h4><ul class="ai-hyp">${r.hypotheses.map((h) => `<li><p><strong>${esc(h.title)}</strong> ${conf(h.confidence)}</p>${h.evidence.length ? `<ul>${h.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}${h.timeRanges.length ? `<p class="small muted">Shown on charts: ${h.timeRanges.map((t) => `${esc(t.from)}–${esc(t.to)}`).join(', ')}</p>` : ''}</li>`).join('')}</ul>` : ''}
      ${r.nextSteps.length ? `<h4>Next steps</h4><ol>${r.nextSteps.map((n) => `<li><span class="owner">${esc(n.owner || '—')}</span>${esc(n.action)}</li>`).join('')}</ol>` : ''}
      ${r.questionsToAsk.length ? `<h4>Questions to ask</h4><ul>${r.questionsToAsk.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
      ${r.customerFacingSummary ? `<h4>For the customer</h4><blockquote>${esc(r.customerFacingSummary)}</blockquote>` : ''}
    </div>`;
}

export function thresholds(): string {
  const rows: [string, string][] = [
    ['Packet loss', `Warning at ${T.lossWarn}%, problem at ${T.lossCrit}% in a sample`],
    ['Jitter', `Warning at ${T.jitterWarn} ms, problem at ${T.jitterCrit} ms`],
    ['Round trip', `Warning at ${T.rttWarn} ms, problem at ${T.rttCrit} ms`],
    ['Receive buffer', `Warning at ${T.bufferWarn} ms`],
    ['Concealed audio', `Warning at ${T.concealWarn}%, problem at ${T.concealCrit}%`],
    ['Speaker glitches', `Warning at ${T.glitchWarn} ms in a sample`],
    ['Estimated MOS', `Poor below ${T.mosPoor} for 10 s or more`],
    ['Audible', 'RMS level of 0.005 or more'],
    ['Hold or dead air', `Silence for ${T.holdMinMs / 1000} s or more`],
    ['Slow setup', `More than ${T.setupWarnMs / 1000} s to connect`],
  ];
  return `<div class="tbl"><table><tbody>${rows.map(([a, b]) => `<tr><th scope="row">${a}</th><td>${b}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted">MOS is estimated with a simplified ITU-T G.107 E-model on the narrowband scale. Use it to compare parts of a call, not as a listening test.</p>`;
}

/** Plain-text summary for pasting into a ticket. */
export function textSummary(c: ViewCtx, v: Verdict, issueLabel: string): string {
  const s = c.m.pc.sprinklr;
  const lines = [
    `Call analysis — ${c.m.start ? new Date(c.m.start).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : ''} · ${duration(c.m.durationMs)}`,
    s ? `Sprinklr case ${s.caseNumber ?? '—'} · conversation ${s.conversationId ?? '—'} · participant ${s.participantId ?? '—'}` : '',
    '',
    `Reported: ${issueLabel}`,
    `Verdict: ${STATUS[v.status].label} — ${v.headline}`,
    ...v.reasons.map((r) => `  • ${r}`),
    '',
    `Estimated MOS: agent hears ${fixed(c.d.summary.mosIn, 2)}, far end hears ${fixed(c.d.summary.mosOut, 2)}`,
    `Ended: ${c.d.summary.endedBy}`,
    '',
    'Findings:',
    ...c.d.findings.filter((f) => f.severity !== 'ok').map((f) => `  [${SEV_LABEL[f.severity]}] ${f.title}${f.evidence[0] ? ` — ${f.evidence[0]}` : ''}`),
    '',
    'Checks passed:',
    ...c.d.findings.filter((f) => f.severity === 'ok').map((f) => `  ✓ ${f.title}`),
  ];
  const out = lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
  return c.showIps ? out : maskIpsInText(out);
}
