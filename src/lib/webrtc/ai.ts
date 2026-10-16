import type { Diagnosis } from './diagnose';
import { elapsed, maskIp, maskIpsInText } from './format';
import type { CallMetrics } from './metrics';
import type { Dump } from './types';
import { ISSUES, type IssueId } from './verdict';

/**
 * The AI round-trip is manual and optional: we build a prompt from a redacted summary, the user
 * pastes it into any AI tool, then pastes the JSON reply back. Nothing here talks to a network.
 * The reply is interpretation only — every number on the page still comes from the dump.
 */

export interface AiReply {
  verdict: string;
  rootCause: { title: string; confidence: 'high' | 'medium' | 'low'; explanation: string };
  agreesWithAnalyser: boolean;
  hypotheses: { title: string; confidence: 'high' | 'medium' | 'low'; evidence: string[]; timeRanges: { from: string; to: string }[] }[];
  nextSteps: { owner: string; action: string }[];
  questionsToAsk: string[];
  customerFacingSummary: string;
}

const SCHEMA = `{
  "verdict": "one sentence",
  "rootCause": { "title": "short", "confidence": "high|medium|low", "explanation": "2-4 sentences" },
  "agreesWithAnalyser": true,
  "hypotheses": [
    { "title": "short", "confidence": "high|medium|low", "evidence": ["cite values from the data"], "timeRanges": [{ "from": "m:ss", "to": "m:ss" }] }
  ],
  "nextSteps": [{ "owner": "agent|it|network|sprinklr|carrier", "action": "concrete step" }],
  "questionsToAsk": ["question for the agent or customer"],
  "customerFacingSummary": "2 plain sentences, no jargon"
}`;

/** Downsample to at most ~90 rows so the prompt fits any AI tool. */
function timeline(m: CallMetrics) {
  const s = m.samples;
  const step = Math.max(1, Math.ceil(s.length / 90));
  const t0 = m.start ?? 0;
  const r = (v: number | null, dp = 1) => (v === null ? null : Number(v.toFixed(dp)));
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < s.length; i += step) {
    const chunk = s.slice(i, i + step);
    const max = (k: keyof (typeof s)[number]) => {
      const v = chunk.map((x) => x[k]).filter((x): x is number => typeof x === 'number');
      return v.length ? Math.max(...v) : null;
    };
    const min = (k: keyof (typeof s)[number]) => {
      const v = chunk.map((x) => x[k]).filter((x): x is number => typeof x === 'number');
      return v.length ? Math.min(...v) : null;
    };
    rows.push([
      elapsed(chunk[0].t0 - t0),
      r(max('inLossPct'), 2),
      r(max('remoteLossPct'), 2),
      r(max('inJitterMs'), 0),
      r(max('rttMs'), 0),
      r(max('jitterBufferMs'), 0),
      r(max('concealPct'), 2),
      r(max('farRms'), 3),
      r(max('micRms'), 3),
      chunk.some((x) => x.micEnabled === false) ? (chunk.every((x) => x.micEnabled === false) ? 'muted' : 'partly') : 'on',
      r(min('mosIn'), 2),
    ]);
  }
  return {
    columns: ['from', 'inLoss%', 'outLoss%', 'jitterMs', 'rttMs', 'bufferMs', 'conceal%', 'farLevel', 'micLevel', 'mic', 'minMOS'],
    rows,
  };
}

export function buildPrompt(dump: Dump, m: CallMetrics, d: Diagnosis, issue: IssueId, note: string): string {
  const t0 = m.start ?? 0;
  const issueLabel = ISSUES.find((i) => i.id === issue)?.label ?? issue;
  const lastT = m.samples.at(-1)?.t ?? Infinity;
  const summary = {
    browser: `${dump.browser.name} ${dump.browser.version ?? ''} on ${dump.browser.os ?? 'unknown OS'}`.trim(),
    durationSec: Math.round(m.durationMs / 1000),
    sampleEverySec: m.cadenceMs ? Math.round(m.cadenceMs / 1000) : null,
    codec: m.codecIn?.mimeType ?? null,
    path: m.local
      ? {
          local: `${m.local.candidateType}/${m.local.protocol}${m.local.relayProtocol ? ` relay ${m.local.relayProtocol}` : ''}`,
          network: m.local.networkType,
          localIp: maskIp(m.local.address),
          remoteIp: maskIp(m.remote?.address),
        }
      : null,
    endedBy: d.summary.endedBy,
    totals: m.totals,
    estimatedMos: { agentHears: d.summary.mosIn, farEndHears: d.summary.mosOut },
    secondsAudible: Object.fromEntries(Object.entries(d.summary.talkMs).map(([k, v]) => [k, Math.round(v / 1000)])),
    connectionEvents: m.states.map((s) => `${elapsed(s.t - t0)} ${s.kind}=${s.state}`),
    findings: d.findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      evidence: f.evidence.map(maskIpsInText),
      when: f.ranges.slice(0, 6).map((r) => `${elapsed(r.from - t0)}-${r.to >= lastT ? 'end' : elapsed(r.to - t0)}`),
    })),
    timeline: timeline(m),
  };

  return `You are a senior VoIP/WebRTC support engineer reviewing one contact-centre call.
The data below was measured from the agent's browser (Chrome webrtc-internals) by a deterministic analyser.
"in" = audio the agent received from the far end; "out" = audio the agent sent (as reported back by the far end).
Levels are RMS 0–1; anything under 0.005 is silence. Times are m:ss from the start of the call.
A range written "m:ss-end" lasted until the stats stopped — nothing changed at that point, the data just ended.

Reported issue: ${issueLabel}
${note.trim() ? `Notes from the person reporting it: ${note.trim()}\n` : ''}
Rules:
- Use ONLY the data below. Do not invent measurements. If the data can't show something, say so.
- Remember this is only the agent's leg. Problems on the customer's phone line or carrier are not visible here.
- Cite specific values and times as evidence. In timeRanges, use "end" for "until the end of the call".
- Reply with ONLY a JSON object in exactly this shape — no markdown, no commentary:
${SCHEMA}

DATA:
${JSON.stringify(summary)}`;
}

/** Parse and validate a pasted reply. Returns readable errors rather than throwing. */
export function parseAiReply(text: string): { ok: true; reply: AiReply } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'No JSON object found. Paste the AI’s full reply.' };
  const body = trimmed.slice(start, end + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    // Chat apps and macOS often "smarten" quotes on copy/paste. Repair that before giving up.
    try {
      raw = JSON.parse(repairJson(body));
    } catch {
      const curly = /[\u201C\u201D\u201E\u201F\u2033]/.test(body);
      return {
        ok: false,
        error: curly
          ? 'The reply has curly “smart” quotes that couldn’t be repaired. Ask the AI to put the JSON in a code block, then copy it with the code block’s copy button.'
          : `The reply isn’t valid JSON (${(e as Error).message}). Ask the AI to reply with only the JSON object.`,
      };
    }
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Expected a JSON object.' };
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max = 600) => (typeof v === 'string' ? clip(v, max) : '');
  const conf = (v: unknown): 'high' | 'medium' | 'low' => (v === 'high' || v === 'medium' || v === 'low' ? v : 'low');
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const rc = (typeof o.rootCause === 'object' && o.rootCause) || {};
  const rcObj = rc as Record<string, unknown>;

  const reply: AiReply = {
    verdict: str(o.verdict, 500),
    rootCause: { title: str(rcObj.title, 120), confidence: conf(rcObj.confidence), explanation: str(rcObj.explanation, 1500) },
    agreesWithAnalyser: o.agreesWithAnalyser === true,
    hypotheses: arr(o.hypotheses)
      .slice(0, 6)
      .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
      .map((h) => ({
        title: str(h.title, 160),
        confidence: conf(h.confidence),
        evidence: arr(h.evidence).map((e) => str(e, 400)).filter(Boolean).slice(0, 8),
        timeRanges: arr(h.timeRanges)
          .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
          .map((r) => ({ from: str(r.from, 10), to: str(r.to, 10) }))
          .filter((r) => parseClock(r.from) !== null && (parseClock(r.to) !== null || r.to.trim().toLowerCase() === 'end'))
          .slice(0, 10),
      })),
    nextSteps: arr(o.nextSteps)
      .filter((n): n is Record<string, unknown> => typeof n === 'object' && n !== null)
      .map((n) => ({ owner: str(n.owner, 30), action: str(n.action, 400) }))
      .filter((n) => n.action)
      .slice(0, 10),
    questionsToAsk: arr(o.questionsToAsk).map((q) => str(q, 300)).filter(Boolean).slice(0, 8),
    customerFacingSummary: str(o.customerFacingSummary, 800),
  };
  if (!reply.verdict && !reply.rootCause.title && !reply.hypotheses.length) {
    return { ok: false, error: 'The JSON doesn’t match the expected shape — it needs at least a verdict, rootCause or hypotheses.' };
  }
  return { ok: true, reply };
}

const OPEN_CLOSE = /[\u201C\u201D\u201E\u201F\u2033]/;

/**
 * Undo common copy/paste damage: curly double quotes used as JSON delimiters, non-breaking and
 * zero-width spaces, and trailing commas. A curly quote is only treated as a delimiter when it
 * sits next to JSON punctuation, so quotation marks inside a sentence survive as text.
 */
export function repairJson(text: string): string {
  const t = text.replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '');
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (!OPEN_CLOSE.test(ch)) {
      out += ch;
      continue;
    }
    // An escaped quote (\" smartened to \“) must stay a valid escape.
    if (t[i - 1] === '\\') {
      out += '"';
      continue;
    }
    let p = i - 1;
    while (p >= 0 && /\s/.test(t[p])) p--;
    let n = i + 1;
    while (n < t.length && /\s/.test(t[n])) n++;
    const before = p < 0 ? '' : t[p];
    const after = n >= t.length ? '' : t[n];
    const structural = before === '' || '{[,:'.includes(before) || after === '' || ':,}]'.includes(after);
    out += structural ? '"' : ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Shorten long text at a word boundary. */
function clip(v: string, max: number): string {
  if (v.length <= max) return v;
  const cut = v.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "4:07" / "1:02:33" → ms. */
export function parseClock(v: string): number | null {
  const m = v.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}
