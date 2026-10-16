import { buildPrompt, parseAiReply, parseClock, type AiReply } from '../../lib/webrtc/ai';
import { diagnose, T, type Diagnosis } from '../../lib/webrtc/diagnose';
import { elapsed } from '../../lib/webrtc/format';
import { deriveMetrics, type CallMetrics, type Sample } from '../../lib/webrtc/metrics';
import { DumpError, parseDump } from '../../lib/webrtc/parse';
import { demoDump } from '../../lib/webrtc/synthetic';
import type { Dump, StatSeries } from '../../lib/webrtc/types';
import { ISSUES, verdictFor, type IssueId } from '../../lib/webrtc/verdict';
import { Charts, esc, type Band, type ChartSpec, type LineSpec } from './chart';
import * as V from './views';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  landing: $('landing'),
  drop: $('drop'),
  file: $<HTMLInputElement>('file'),
  demo: $<HTMLButtonElement>('demo'),
  issue: $<HTMLSelectElement>('issue'),
  note: $<HTMLTextAreaElement>('note'),
  error: $('load-error'),
  report: $('report'),
  pcPick: $('pc-pick'),
  head: $('rep-head'),
  verdict: $('verdict'),
  verdictBox: $('verdict-box'),
  cards: $('scorecards'),
  findings: $('findings'),
  timeline: $('timeline'),
  charts: $('charts'),
  chartsMore: $('charts-more'),
  connection: $('connection'),
  negotiations: $('negotiations'),
  device: $('device'),
  totals: $('totals'),
  explorerSeries: $<HTMLSelectElement>('ex-series'),
  explorerField: $<HTMLSelectElement>('ex-field'),
  explorerRate: $<HTMLInputElement>('ex-rate'),
  explorerChart: $('ex-chart'),
  logFilter: $<HTMLSelectElement>('log-filter'),
  log: $('log'),
  thresholds: $('thresholds'),
  prompt: $<HTMLTextAreaElement>('ai-prompt'),
  copyPrompt: $<HTMLButtonElement>('ai-copy'),
  reply: $<HTMLTextAreaElement>('ai-reply'),
  showReply: $<HTMLButtonElement>('ai-show'),
  clearReply: $<HTMLButtonElement>('ai-clear'),
  replyError: $('ai-error'),
  aiOut: $('ai-out'),
  aiBanner: $('ai-banner'),
  aiIssue: $<HTMLSelectElement>('ai-issue'),
  aiSteps: $('ai-steps'),
  aiDot: $('ai-dot'),
  tabReport: $<HTMLButtonElement>('tab-report'),
  tabAi: $<HTMLButtonElement>('tab-ai'),
  viewReport: $('view-report'),
  viewAi: $('view-ai'),
  showIps: $<HTMLInputElement>('show-ips'),
  copySummary: $<HTMLButtonElement>('copy-summary'),
  print: $<HTMLButtonElement>('print'),
  reset: $<HTMLButtonElement>('reset'),
  status: $('status'),
};

interface State {
  dump: Dump;
  fileName: string;
  pcIndex: number;
  m: CallMetrics;
  d: Diagnosis;
  charts: Charts | null;
  explorer: Charts | null;
  pinned: Band[];
  hover: Band[];
  ai: AiReply | null;
  aiCharts: Charts | null;
  /** The prompt has been copied at least once — step 2 is done. */
  copied: boolean;
}
let state: State | null = null;

for (const i of ISSUES) {
  els.issue.append(new Option(i.label, i.id));
  els.aiIssue.append(new Option(i.label, i.id));
}

// ── Loading ───────────────────────────────────────────────────────────────

function load(text: string, fileName: string) {
  els.error.hidden = true;
  let dump: Dump;
  try {
    dump = parseDump(text);
  } catch (e) {
    els.error.textContent = e instanceof DumpError ? e.message : 'Couldn’t read this file.';
    els.error.hidden = false;
    return;
  }
  if (!dump.connections.length) {
    els.error.textContent = 'This dump contains no peer connections — there was no call in the browser tab when it was exported.';
    els.error.hidden = false;
    return;
  }
  // Default to the connection with the most data.
  const pcIndex = dump.connections.map((c, i) => [c.stats.size, i]).sort((a, b) => b[0] - a[0])[0][1];
  state?.charts?.destroy();
  state?.explorer?.destroy();
  state?.aiCharts?.destroy();
  state = { dump, fileName, pcIndex, ...analyse(dump, pcIndex), charts: null, explorer: null, pinned: [], hover: [], ai: null, aiCharts: null, copied: false };
  els.reply.value = '';
  els.aiOut.innerHTML = '';
  els.replyError.hidden = true;
  renderAll();
  renderAi();
  els.landing.hidden = true;
  els.report.hidden = false;
  window.scrollTo({ top: 0 });
  if (new URLSearchParams(location.search).get('view') === 'ai') setView('ai');
  else $('rep-title')?.focus({ preventScroll: true });
}

function analyse(dump: Dump, i: number) {
  const m = deriveMetrics(dump.connections[i]);
  return { m, d: diagnose(dump, m) };
}

async function readFile(f: File) {
  if (f.size > 60 * 1024 * 1024) {
    els.error.textContent = 'That file is over 60 MB — export a single call rather than a whole session.';
    els.error.hidden = false;
    return;
  }
  load(await f.text(), f.name);
}

els.file.addEventListener('change', () => {
  const f = els.file.files?.[0];
  if (f) readFile(f);
});
for (const ev of ['dragenter', 'dragover'] as const) {
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
}
for (const ev of ['dragleave', 'drop'] as const) {
  els.drop.addEventListener(ev, () => els.drop.classList.remove('over'));
}
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) readFile(f);
});
els.demo.addEventListener('click', () => {
  if (els.issue.value === 'none') els.issue.value = 'choppy';
  load(demoDump(), 'demo-call.json (synthetic)');
});
els.reset.addEventListener('click', () => {
  state?.charts?.destroy();
  state?.explorer?.destroy();
  state?.aiCharts?.destroy();
  state = null;
  setView('report', false);
  els.report.hidden = true;
  els.landing.hidden = false;
  els.file.value = '';
  window.scrollTo({ top: 0 });
  els.drop.focus();
});

// A file dropped anywhere on the page loads, whether or not a report is showing.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f && !els.drop.contains(e.target as Node)) readFile(f);
});

// ── Rendering ─────────────────────────────────────────────────────────────

const ctx = (): V.ViewCtx => ({ dump: state!.dump, m: state!.m, d: state!.d, showIps: els.showIps.checked, fileName: state!.fileName });
const issue = () => els.issue.value as IssueId;
const issueLabel = () => ISSUES.find((i) => i.id === issue())?.label ?? '';

function renderAll() {
  const s = state!;
  els.pcPick.innerHTML =
    s.dump.connections.length > 1
      ? `<label>Connection <select id="pc-select">${s.dump.connections
          .map((c, i) => `<option value="${i}" ${i === s.pcIndex ? 'selected' : ''}>${i + 1}: ${esc(c.key.slice(0, 18))} · ${c.stats.size} stats · ${c.events.length} events</option>`)
          .join('')}</select></label>`
      : '';
  document.getElementById('pc-select')?.addEventListener('change', (e) => {
    s.pcIndex = Number((e.target as HTMLSelectElement).value);
    Object.assign(s, analyse(s.dump, s.pcIndex));
    s.pinned = [];
    renderAll();
    renderAiResult();
    renderAi();
  });

  renderText();
  renderCharts();
  renderExplorer();
  renderLogFilter();
  els.thresholds.innerHTML = V.thresholds();
}

/** Everything that depends on the IP toggle or the reported issue. */
function renderText() {
  const c = ctx();
  els.head.innerHTML = V.header(c);
  renderVerdict();
  els.cards.innerHTML = V.scorecards(c);
  els.findings.innerHTML = V.findingsList(c);
  els.connection.innerHTML = V.connection(c);
  els.negotiations.innerHTML = V.negotiations(c);
  els.device.innerHTML = V.device(c);
  els.totals.innerHTML = V.totals(c);
  els.log.innerHTML = V.eventLog(c, state!.m.pc, els.logFilter.value);
  wireFindings();
}

function renderVerdict() {
  const s = state!;
  const v = verdictFor(issue(), s.d, s.m);
  els.verdict.innerHTML = V.verdictBody(v);
  els.verdictBox.className = `verdict ${V.STATUS[v.status].tone}`;
  els.prompt.value = buildPrompt(s.dump, s.m, s.d, issue(), els.note.value);
}

function wireFindings() {
  const s = state!;
  els.findings.querySelectorAll<HTMLDetailsElement>('[data-finding]').forEach((row) => {
    const f = s.d.findings[Number(row.dataset.finding)];
    if (!f.ranges.length) return;
    const bands = () => f.ranges.map((r) => ({ from: r.from, to: Math.max(r.to, r.from + 1000), cls: `hl-${f.severity}`, label: f.title }));
    // Hovering a finding previews its time ranges on every chart.
    row.addEventListener('mouseenter', () => {
      s.hover = bands();
      applyBands();
    });
    row.addEventListener('mouseleave', () => {
      s.hover = [];
      applyBands();
    });
    const btn = row.querySelector<HTMLButtonElement>('[data-show]');
    btn?.addEventListener('click', () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      els.findings.querySelectorAll<HTMLButtonElement>('[data-show]').forEach((b) => {
        b.setAttribute('aria-pressed', 'false');
        b.textContent = 'Show on Charts';
        b.closest('.finding')?.classList.remove('lit');
      });
      if (on) {
        btn.setAttribute('aria-pressed', 'true');
        btn.textContent = 'Hide from Charts';
        row.classList.add('lit');
      }
      s.pinned = on ? bands() : [];
      applyBands();
      if (on) els.timeline.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    });
  });
}

function aiBands(): Band[] {
  const s = state!;
  if (!s.ai) return [];
  const t0 = s.m.start ?? 0;
  return s.ai.hypotheses.flatMap((h) =>
    h.timeRanges.map((r) => {
      const from = t0 + parseClock(r.from)!;
      const to = parseClock(r.to) === null ? (s.m.end ?? from) : t0 + parseClock(r.to)!;
      return { from, to: Math.max(to, from + 1000), cls: 'hl-ai', label: `AI: ${h.title}` };
    }),
  );
}

function applyBands() {
  const s = state!;
  s.charts?.setBands([...aiBands(), ...s.pinned, ...s.hover]);
}

/** The six charts that answer most questions; the rest sit under "More Charts". */
const PRIMARY = ['mos', 'loss', 'jitter', 'rtt', 'conceal', 'levels'];

function renderCharts() {
  const s = state!;
  s.charts?.destroy();
  const { m, d } = s;
  if (!m.hasStats || m.start === null || m.end === null) {
    els.timeline.innerHTML = '<p class="muted">No stats in this dump, so there’s nothing to chart.</p>';
    els.charts.innerHTML = '';
    els.chartsMore.innerHTML = '';
    s.charts = null;
    return;
  }
  const charts = new Charts(m.start, m.end);
  s.charts = charts;
  const smp = m.samples;
  const t = smp.map((x) => (x.t0 + x.t) / 2);
  const col = (k: keyof Sample) => smp.map((x) => x[k] as number | null);
  const has = (...k: (keyof Sample)[]) => k.some((key) => smp.some((x) => x[key] !== null));
  const muted: Band[] = d.muted.map((r) => ({ ...r, cls: 'muted', label: 'Agent muted' }));

  // Timeline lanes.
  const far = d.activity.filter((a) => a.state === 'far' || a.state === 'both').map((a) => ({ from: a.from, to: a.to, cls: 'far', label: 'Far end audible' }));
  const agent = d.activity.filter((a) => a.state === 'agent' || a.state === 'both').map((a) => ({ from: a.from, to: a.to, cls: 'agent', label: 'Agent audible' }));
  const hold = d.hold.map((r) => ({ ...r, cls: 'hold', label: 'Looks like hold' }));
  const stateMarkers = m.states
    .filter((x) => x.kind === 'Connection' || (x.kind === 'ICE' && /disconnected|failed/.test(x.state)))
    .map((x) => ({ t: x.t, cls: /failed|disconnected|closed/.test(x.state) ? 'bad' : x.state === 'connected' ? 'good' : 'neutral', label: `${elapsed(x.t - m.start!)} ${x.kind}: ${x.state}` }));
  const negMarkers = m.negotiations.filter((n) => n.side === 'remote').map((n) => ({ t: n.t, cls: 'neg', label: `${elapsed(n.t - m.start!)} offer from media server (${n.sdp.media[0]?.direction ?? ''})` }));
  const closeEvt = m.pc.events.filter((e) => e.type === 'close').map((e) => ({ t: e.t, cls: 'neutral', label: `${elapsed(e.t - m.start!)} closed` }));
  const problemSpans = d.findings
    .filter((f) => f.severity === 'critical' || f.severity === 'warning')
    .flatMap((f) => f.ranges.map((r) => ({ from: r.from, to: Math.max(r.to, r.from + 2000), cls: f.severity, label: f.title })))
    // Paint problems over warnings where they overlap.
    .sort((a, b) => (a.cls === b.cls ? 0 : a.cls === 'critical' ? 1 : -1));

  charts.mount(els.timeline, {
    kind: 'lanes',
    title: 'Call Timeline',
    lanes: [
      { label: 'Far end', spans: far },
      { label: 'Agent', spans: [...muted, ...hold.map((h) => ({ ...h, cls: 'hold-agent' })), ...agent] },
      { label: 'Connection', spans: [], markers: [...stateMarkers, ...negMarkers, ...closeEvt] },
      { label: 'Problems', spans: problemSpans },
    ],
  });

  const pct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;
  const ms = (v: number) => `${Math.round(v)} ms`;
  const specs: (LineSpec & { show: boolean; id: string; blurb: string })[] = [
    { id: 'mos', show: has('mosIn', 'mosOut'), kind: 'line', title: 'Call Quality (Estimated MOS)', blurb: '4.3+ is excellent for a phone call; under 3.6 most people notice.', t, series: [{ label: 'Agent hears', cls: 's1', values: col('mosIn') }, { label: 'Far end hears', cls: 's2', values: col('mosOut') }], format: (v) => v.toFixed(1), yMin: 1, yMax: 4.5, thresholds: [{ y: T.mosPoor, label: 'poor', cls: 'warn' }] },
    { id: 'loss', show: has('inLossPct', 'remoteLossPct'), kind: 'line', title: 'Packet Loss', blurb: 'Share of audio packets that never arrived, per sample.', t, series: [{ label: 'Received', cls: 's1', values: col('inLossPct') }, { label: 'Sent (far-end report)', cls: 's2', values: col('remoteLossPct') }], format: pct, yFloor: 5, thresholds: [{ y: T.lossWarn, label: `${T.lossWarn}%`, cls: 'warn' }, { y: T.lossCrit, label: `${T.lossCrit}%`, cls: 'crit' }] },
    { id: 'jitter', show: has('inJitterMs', 'remoteJitterMs'), kind: 'line', title: 'Jitter', blurb: 'How unevenly packets arrived.', t, series: [{ label: 'Received', cls: 's1', values: col('inJitterMs') }, { label: 'Sent (far-end report)', cls: 's2', values: col('remoteJitterMs') }], format: ms, yFloor: 20, thresholds: [{ y: T.jitterWarn, label: `${T.jitterWarn} ms`, cls: 'warn' }, { y: T.jitterCrit, label: `${T.jitterCrit} ms`, cls: 'crit' }] },
    { id: 'rtt', show: has('rttMs'), kind: 'line', title: 'Latency (Round Trip)', blurb: 'Agent → media server → agent.', t, series: [{ label: 'Round trip', cls: 's3', values: col('rttMs') }], format: ms, yFloor: 100, thresholds: [{ y: T.rttWarn, label: `${T.rttWarn} ms`, cls: 'warn' }] },
    { id: 'buffer', show: has('jitterBufferMs'), kind: 'line', title: 'Receive Buffer Delay', blurb: 'How long audio waited before playing. Grows when packets arrive unevenly.', t, series: [{ label: 'Buffer', cls: 's1', values: col('jitterBufferMs') }], format: ms, yFloor: 100, thresholds: [{ y: T.bufferWarn, label: `${T.bufferWarn} ms`, cls: 'warn' }] },
    { id: 'conceal', show: has('concealPct'), kind: 'line', title: 'Concealed Audio', blurb: 'Audio the browser had to invent to cover gaps — heard as robotic or choppy.', t, series: [{ label: 'Concealed', cls: 's1', values: col('concealPct') }], format: pct, yFloor: 5, thresholds: [{ y: T.concealWarn, label: `${T.concealWarn}%`, cls: 'warn' }, { y: T.concealCrit, label: `${T.concealCrit}%`, cls: 'crit' }] },
    { id: 'levels', show: has('farRms', 'micRms'), kind: 'line', title: 'Audio Levels', blurb: 'Loudness on each side. Shaded where the agent was muted.', t, series: [{ label: 'Far end', cls: 's2', values: col('farRms') }, { label: 'Agent mic', cls: 's1', values: col('micRms') }], format: (v) => v.toFixed(3), yFloor: 0.05, bands: muted },
    { id: 'bitrate', show: has('inKbps', 'outKbps'), kind: 'line', title: 'Bitrate', blurb: 'Drops to near zero mean silence suppression or a stall.', t, series: [{ label: 'Received', cls: 's1', values: col('inKbps') }, { label: 'Sent', cls: 's2', values: col('outKbps') }], format: (v) => `${Math.round(v)} kbps`, yFloor: 20 },
    { id: 'pps', show: has('inPps', 'outPps'), kind: 'line', title: 'Packets per Second', blurb: '50/s is normal for 20 ms packets; 0 means nothing is flowing.', t, series: [{ label: 'Received', cls: 's1', values: col('inPps') }, { label: 'Sent', cls: 's2', values: col('outPps') }], format: (v) => `${Math.round(v)}/s`, yFloor: 60 },
    { id: 'glitch', show: smp.some((x) => (x.playoutGlitchMs ?? 0) > 0), kind: 'line', title: 'Speaker Glitches', blurb: 'Audio the headset needed but didn’t get in time — a local PC/device problem.', t, series: [{ label: 'Glitch', cls: 's3', values: col('playoutGlitchMs') }], format: ms, yFloor: 100, thresholds: [{ y: T.glitchWarn, label: `${T.glitchWarn} ms`, cls: 'warn' }] },
  ];
  const card = (x: (typeof specs)[number]) =>
    `<figure class="chart-card"><figcaption><span class="c-title">${esc(x.title)}</span><span class="legend">${x.series.length > 1 ? x.series.map((se) => `<span><i class="sw ${se.cls}"></i>${esc(se.label)}</span>`).join('') : ''}</span></figcaption><p class="c-blurb">${esc(x.blurb)}</p><div class="chart" data-chart="${x.id}" role="img" aria-label="${esc(`${x.title} chart`)}"></div></figure>`;
  const shown = specs.filter((x) => x.show);
  const primary = shown.filter((x) => PRIMARY.includes(x.id));
  const secondary = shown.filter((x) => !PRIMARY.includes(x.id));
  els.charts.innerHTML = primary.map(card).join('');
  els.chartsMore.innerHTML = secondary.map(card).join('') || '<p class="muted">No other charts for this call.</p>';
  for (const x of shown) charts.mount(document.querySelector(`[data-chart="${x.id}"]`) as HTMLElement, x as ChartSpec);
  applyBands();
}

// ── Raw stats explorer ────────────────────────────────────────────────────

function renderExplorer() {
  const s = state!;
  const series = [...s.m.pc.stats.values()].filter((x) => x.t.length > 1).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  els.explorerSeries.innerHTML = series.map((x) => `<option value="${esc(x.id)}">${esc(x.type)} · ${esc(x.id)}</option>`).join('');
  const preferred = s.m.ids.inbound ?? series[0]?.id;
  if (preferred) els.explorerSeries.value = preferred;
  fillFields();
}

function numericFields(st: StatSeries) {
  return Object.entries(st.fields)
    .filter(([, v]) => v.some((x) => typeof x === 'number'))
    .map(([k]) => k)
    .sort();
}

function fillFields() {
  const s = state!;
  const st = s.m.pc.stats.get(els.explorerSeries.value);
  if (!st) {
    els.explorerField.innerHTML = '';
    els.explorerChart.innerHTML = '<p class="muted">No time-series stats in this dump.</p>';
    return;
  }
  const fields = numericFields(st);
  els.explorerField.innerHTML = fields.map((f) => `<option>${esc(f)}</option>`).join('');
  const pick = ['packetsReceived', 'packetsSent', 'jitter', 'currentRoundTripTime', 'audioLevel'].find((f) => fields.includes(f));
  if (pick) els.explorerField.value = pick;
  drawExplorer();
}

function drawExplorer() {
  const s = state!;
  s.explorer?.destroy();
  const st = s.m.pc.stats.get(els.explorerSeries.value);
  const field = els.explorerField.value;
  if (!st || !field || s.m.start === null || s.m.end === null) return;
  const raw = st.fields[field].map((v) => (typeof v === 'number' ? v : null));
  const counter = raw.every((v, i) => i === 0 || v === null || raw[i - 1] === null || v >= raw[i - 1]!);
  els.explorerRate.disabled = !counter;
  const rate = counter && els.explorerRate.checked;
  const values = rate
    ? raw.map((v, i) => (i === 0 || v === null || raw[i - 1] === null ? null : (v - raw[i - 1]!) / ((st.t[i] - st.t[i - 1]) / 1000)))
    : raw;
  s.explorer = new Charts(s.m.start, s.m.end);
  s.explorer.mount(els.explorerChart, {
    kind: 'line',
    title: field,
    t: st.t,
    series: [{ label: rate ? `${field} / s` : field, cls: 's1', values }],
    format: (v) => (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(v.toPrecision(3)).toString()),
  });
}

els.explorerSeries.addEventListener('change', fillFields);
els.explorerField.addEventListener('change', drawExplorer);
els.explorerRate.addEventListener('change', drawExplorer);

// ── Event log ─────────────────────────────────────────────────────────────

function renderLogFilter() {
  const types = [...new Set(state!.m.pc.events.map((e) => e.type))].sort();
  els.logFilter.innerHTML = `<option value="">All events (${state!.m.pc.events.length})</option>` + types.map((t) => `<option>${esc(t)}</option>`).join('');
}
els.logFilter.addEventListener('change', () => {
  if (state) els.log.innerHTML = V.eventLog(ctx(), state.m.pc, els.logFilter.value);
});

// ── Controls ──────────────────────────────────────────────────────────────

function setIssue(id: string) {
  els.issue.value = id;
  els.aiIssue.value = id;
  // Keep the chosen problem in the URL so a refreshed or shared link reopens with it.
  const q = new URLSearchParams(location.search);
  if (id === 'none') q.delete('issue');
  else q.set('issue', id);
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  if (state) {
    renderVerdict();
    renderAi();
  }
}
els.issue.addEventListener('change', () => setIssue(els.issue.value));
els.aiIssue.addEventListener('change', () => setIssue(els.aiIssue.value));
els.note.addEventListener('input', () => {
  if (!state) return;
  renderVerdict();
  renderSteps();
});
els.showIps.addEventListener('change', () => state && renderText());

function flash(msg: string) {
  els.status.textContent = msg;
  setTimeout(() => (els.status.textContent = ''), 2500);
}
async function copy(text: string, msg: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    flash(msg);
    return true;
  } catch {
    flash('Couldn’t reach the clipboard — select the text and copy it manually.');
    return false;
  }
}
els.copySummary.addEventListener('click', () => state && copy(V.textSummary(ctx(), verdictFor(issue(), state.d, state.m), issueLabel()), 'Summary copied — paste it into the ticket.'));
els.print.addEventListener('click', () => {
  document.querySelectorAll('#view-report details').forEach((d) => d.setAttribute('open', ''));
  window.print();
});

// ── Views: Analysis ⇄ AI workspace ────────────────────────────────────────

type View = 'report' | 'ai';

function setView(view: View, focus = true) {
  const ai = view === 'ai';
  els.viewReport.hidden = ai;
  els.viewAi.hidden = !ai;
  els.tabReport.setAttribute('aria-selected', String(!ai));
  els.tabAi.setAttribute('aria-selected', String(ai));
  els.tabReport.tabIndex = ai ? -1 : 0;
  els.tabAi.tabIndex = ai ? 0 : -1;
  const q = new URLSearchParams(location.search);
  if (ai) q.set('view', 'ai');
  else q.delete('view');
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  if (!focus) return;
  window.scrollTo({ top: 0 });
  // Move focus into the new view so keyboard and screen-reader users land where the content changed.
  ($(ai ? 'ai-title' : 'rep-title') as HTMLElement | null)?.focus({ preventScroll: true });
}

els.tabReport.addEventListener('click', () => setView('report'));
els.tabAi.addEventListener('click', () => setView('ai'));
for (const tab of [els.tabReport, els.tabAi]) {
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === els.tabReport ? els.tabAi : els.tabReport;
    setView(next === els.tabAi ? 'ai' : 'report', false);
    next.focus();
  });
}
els.aiBanner.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-open-ai]')) setView('ai');
});

// ── AI workspace ──────────────────────────────────────────────────────────

function renderAi() {
  if (!state) return;
  els.aiIssue.value = els.issue.value;
  renderSteps();
  renderAiBanner();
  els.aiDot.hidden = !state.ai;
}

/** Highlight the step to do next; tick the ones already done. */
function renderSteps() {
  const s = state!;
  const done = {
    1: issue() !== 'none' || els.note.value.trim() !== '',
    2: s.copied || !!s.ai,
    3: !!s.ai,
  };
  const current = !done[2] ? 2 : !done[3] ? 3 : 0;
  els.aiSteps.querySelectorAll<HTMLElement>('[data-step]').forEach((li) => {
    const n = Number(li.dataset.step) as 1 | 2 | 3;
    li.classList.toggle('done', done[n]);
    li.classList.toggle('current', n === current);
    if (n === current) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
}

function renderAiBanner() {
  const s = state!;
  const icon = '<span class="ab-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="18" height="18"><path d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6z" fill="currentColor"/></svg></span>';
  if (!s.ai) {
    els.aiBanner.innerHTML = `${icon}
      <div class="ab-text"><strong>Want a second opinion?</strong><span>Copy a ready-made prompt into ChatGPT, Claude or any AI tool, then paste its reply here. Nothing is sent from this page.</span></div>
      <button type="button" class="btn ai" data-open-ai>Get AI Opinion</button>`;
    return;
  }
  const r = s.ai;
  els.aiBanner.innerHTML = `${icon}
    <div class="ab-text"><strong>AI opinion: ${esc(r.verdict || r.rootCause.title)}</strong><span>${r.agreesWithAnalyser ? 'Agrees with' : 'Doesn’t fully agree with'} the measured findings${r.rootCause.title ? ` · likely cause: ${esc(r.rootCause.title)} (${esc(r.rootCause.confidence)} confidence)` : ''}. Its time ranges are shaded purple on the charts.</span></div>
    <button type="button" class="btn ai" data-open-ai>View Opinion</button>`;
}

function renderAiResult() {
  const s = state!;
  s.aiCharts?.destroy();
  s.aiCharts = null;
  if (!s.ai) {
    els.aiOut.innerHTML = '';
    return;
  }
  const v = verdictFor(issue(), s.d, s.m);
  const st = V.STATUS[v.status];
  const problems = s.d.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning');
  const r = s.ai;
  els.aiOut.innerHTML = `
    <section class="ai-result" aria-labelledby="ai-result-title">
      <h3 class="rh" id="ai-result-title" tabindex="-1">Measured vs AI</h3>
      <div class="vs">
        <div class="vs-col">
          <p class="who">Measured by this site</p>
          <span class="badge ${st.tone}">${esc(st.label)}</span>
          <h4>${esc(v.headline)}</h4>
          ${problems.length ? `<ul>${problems.slice(0, 4).map((f) => `<li>${esc(f.title)}</li>`).join('')}</ul>` : '<p class="small muted">No problems found.</p>'}
        </div>
        <div class="vs-col ai-side">
          <p class="who">AI opinion · not measured</p>
          ${r.rootCause.title ? `<span class="badge violet">${esc(r.rootCause.confidence)} confidence</span>` : ''}
          <h4>${esc(r.verdict || r.rootCause.title)}</h4>
          ${r.rootCause.title && r.verdict ? `<p class="small muted">Likely cause: ${esc(r.rootCause.title)}</p>` : ''}
        </div>
      </div>
      <p class="agree"><span class="badge ${r.agreesWithAnalyser ? 'green' : 'amber'}">${r.agreesWithAnalyser ? 'Agrees' : 'Disagrees'}</span>${r.agreesWithAnalyser ? 'The AI agrees with the measured findings.' : 'Compare the AI’s reasoning with the measured evidence before acting.'}</p>
      ${aiBands().length && s.m.start !== null ? '<div class="panel ai-tl"><div class="chart" id="ai-timeline"></div><p class="legend lanes-legend"><span><i class="sw violet"></i>Times the AI points to</span><span><i class="sw red"></i>Measured problem</span><span><i class="sw amber"></i>Measured warning</span><span><i class="sw muted"></i>Agent muted</span></p></div>' : ''}
      <div class="ai-actions">
        <button type="button" class="btn" id="ai-to-charts">Show on All Charts</button>
      </div>
      ${V.aiCard(r)}
    </section>`;

  const el = document.getElementById('ai-timeline');
  if (el && s.m.start !== null && s.m.end !== null) {
    s.aiCharts = new Charts(s.m.start, s.m.end);
    s.aiCharts.mount(el, {
      kind: 'lanes',
      title: 'AI vs measured',
      lanes: [
        { label: 'AI', spans: aiBands().map((b) => ({ ...b, cls: 'ai' })) },
        {
          label: 'Measured',
          spans: problems
            .flatMap((f) => f.ranges.map((x) => ({ from: x.from, to: Math.max(x.to, x.from + 2000), cls: f.severity, label: f.title })))
            .sort((a, b) => (a.cls === b.cls ? 0 : a.cls === 'critical' ? 1 : -1)),
        },
        { label: 'Muted', spans: s.d.muted.map((x) => ({ ...x, cls: 'muted', label: 'Agent muted' })) },
      ],
    });
  }
  document.getElementById('ai-to-charts')?.addEventListener('click', () => {
    setView('report', false);
    document.getElementById('charts')?.scrollIntoView({ block: 'start' });
  });
}

function showReply(): boolean {
  if (!state) return false;
  const r = parseAiReply(els.reply.value);
  if (!r.ok) {
    els.replyError.textContent = r.error;
    els.replyError.hidden = false;
    return false;
  }
  els.replyError.hidden = true;
  state.ai = r.reply;
  renderAiResult();
  renderAi();
  applyBands();
  const title = document.getElementById('ai-result-title');
  title?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  title?.focus({ preventScroll: true });
  return true;
}

function markCopied() {
  if (!state) return;
  state.copied = true;
  renderSteps();
}

els.copyPrompt.addEventListener('click', async () => {
  if (!state) return;
  const msg = $('ai-copy-msg');
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  let ok = false;
  try {
    await navigator.clipboard.writeText(els.prompt.value);
    ok = true;
  } catch {
    // Some browsers (and locked-down corporate ones) refuse the async clipboard; try the old way.
    const peek = $<HTMLDetailsElement>('ai-peek');
    peek.open = true;
    els.prompt.focus();
    els.prompt.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
  }
  if (ok) {
    msg.textContent = 'Copied. Paste it into your AI tool, then paste its reply in step 3.';
    els.copyPrompt.textContent = 'Copied ✓';
    setTimeout(() => (els.copyPrompt.textContent = 'Copy Prompt'), 2000);
    markCopied();
  } else {
    msg.textContent = `Your browser blocked automatic copying. The prompt is selected below, so press ${isMac ? '⌘C' : 'Ctrl+C'} to copy it.`;
  }
});
// Copying the prompt by hand counts too.
els.prompt.addEventListener('copy', markCopied);
els.showReply.addEventListener('click', showReply);
// Read the reply as soon as it's pasted; no extra click needed.
els.reply.addEventListener('paste', () => setTimeout(() => els.reply.value.trim() && showReply(), 0));
els.clearReply.addEventListener('click', () => {
  if (!state) return;
  state.ai = null;
  els.reply.value = '';
  els.replyError.hidden = true;
  renderAiResult();
  renderAi();
  applyBands();
  els.reply.focus();
});

// ── Deep links ────────────────────────────────────────────────────────────
// ?issue=choppy preselects the reported issue; ?demo loads the synthetic demo call.
// In dev only, ?sample=<name> loads samples/<name>.json (real dumps, never deployed).
{
  const q = new URLSearchParams(location.search);
  const wanted = q.get('issue');
  if (wanted && ISSUES.some((i) => i.id === wanted)) {
    els.issue.value = wanted;
    els.aiIssue.value = wanted;
  }
  if (q.has('demo')) els.demo.click();
  const sample = q.get('sample');
  if (import.meta.env.DEV && sample && /^[\w-]+$/.test(sample)) {
    fetch(`/samples/${sample}.json`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((text) => load(text, `${sample}.json`))
      .catch(() => {
        els.error.textContent = `No samples/${sample}.json in this checkout.`;
        els.error.hidden = false;
      });
  }
}
