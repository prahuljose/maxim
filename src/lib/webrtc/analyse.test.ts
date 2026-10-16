import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt, parseAiReply, parseClock, repairJson } from './ai';
import { diagnose } from './diagnose';
import { maskIp, maskIpsInText } from './format';
import { deriveMetrics, estimateMos } from './metrics';
import { DumpError, parseDump, resolveLogTimes } from './parse';
import { parseSdp, splitDescription } from './sdp';
import { makeDump, talk } from './synthetic';
import { verdictFor, type IssueId } from './verdict';

function analyse(text: string) {
  const dump = parseDump(text);
  const m = deriveMetrics(dump.connections[0]);
  const d = diagnose(dump, m);
  return { dump, m, d, ids: d.findings.map((f) => f.id), verdict: (i: IssueId) => verdictFor(i, d, m) };
}

describe('parsing', () => {
  it('rejects files that are not dumps', () => {
    expect(() => parseDump('not json')).toThrow(DumpError);
    expect(() => parseDump('{"foo":1}')).toThrow(/PeerConnections/);
  });

  it('splits stat ids that contain dashes', () => {
    const dump = parseDump(JSON.stringify({ PeerConnections: { a: { stats: { 'CP-a_b/c-bytesSent': { statsType: 'candidate-pair', values: '[1,2]', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:00:01Z' } }, updateLog: [] } } }));
    expect([...dump.connections[0].stats.keys()]).toEqual(['CP-a_b/c']);
  });

  it('reads day-first and month-first event times and removes the timezone', () => {
    const stats = Date.UTC(2026, 9, 8, 8, 3, 41);
    expect(resolveLogTimes(['08/10/2026, 08:03:43'], stats)[0]).toBe(Date.UTC(2026, 9, 8, 8, 3, 43));
    expect(resolveLogTimes(['10/8/2026, 1:33:43 PM'], stats)[0]).toBe(Date.UTC(2026, 9, 8, 8, 3, 43)); // IST, +5:30
  });

  it('pulls Sprinklr identifiers out of the console URL', () => {
    const { m } = analyse(makeDump({ seconds: 5 }));
    expect(m.pc.sprinklr).toMatchObject({ caseNumber: '1', conversationId: 'c1', participantId: 'p1' });
  });

  it('parses SDP direction, codecs and candidates', () => {
    const { sdp } = splitDescription('type: offer, sdp: v=0\r\nm=audio 9 RTP/SAVPF 0 102\r\na=rtpmap:102 opus/48000/2\r\na=sendonly\r\na=candidate:1 1 udp 1 1.2.3.4 5 typ host\r\n');
    const p = parseSdp(sdp);
    expect(p.media[0].direction).toBe('sendonly');
    expect(p.media[0].codecs.map((c) => c.name)).toEqual(['PCMU', 'opus']);
    expect(p.media[0].candidates[0]).toMatchObject({ address: '1.2.3.4', type: 'host' });
  });
});

describe('MOS estimate', () => {
  it('is near 4.4 for a perfect G.711 call and falls with loss and delay', () => {
    expect(estimateMos(0, 50, 'PCMU')).toBeGreaterThan(4.3);
    expect(estimateMos(5, 50, 'PCMU')).toBeLessThan(estimateMos(1, 50, 'PCMU'));
    expect(estimateMos(0, 400, 'PCMU')).toBeLessThan(3.8);
  });
});

describe('diagnosis on synthetic calls', () => {
  it('passes a clean call', () => {
    const a = analyse(makeDump({ seconds: 60, at: talk }));
    expect(a.d.summary.counts.critical + a.d.summary.counts.warning).toBe(0);
    expect(a.ids).toEqual(expect.arrayContaining(['clean-in', 'clean-out', 'direct', 'rtt-ok']));
    expect(a.verdict('choppy').status).toBe('not-found');
    expect(a.d.summary.endedBy).toMatch(/Closed normally/);
  });

  it('confirms choppy audio from loss and concealment', () => {
    const a = analyse(makeDump({ seconds: 60, at: (i) => (i >= 20 && i < 40 ? { ...talk(i), loss: 0.08, conceal: 0.1 } : talk(i)) }));
    const loss = a.d.findings.find((f) => f.id === 'loss-in')!;
    expect(loss.severity).toBe('critical');
    expect(loss.ranges[0].to - loss.ranges[0].from).toBeCloseTo(20_000, -3);
    expect(a.ids).toContain('conceal');
    expect(a.verdict('choppy').status).toBe('confirmed');
  });

  it('attributes outbound loss to what the customer heard', () => {
    const a = analyse(makeDump({ seconds: 30, at: (i) => ({ ...talk(i), remoteLoss: i > 10 ? 0.06 : 0 }) }));
    expect(a.ids).toContain('loss-out');
    expect(a.ids).toContain('clean-in');
    expect(a.verdict('choppy').headline).toMatch(/customer heard/);
  });

  it('flags one-way audio when far-end packets carry silence', () => {
    const a = analyse(makeDump({ seconds: 60, at: () => ({ micRms: 0.04, farRms: 0 }) }));
    expect(a.ids).toContain('far-silent');
    expect(a.verdict('agent-cant-hear').status).toBe('confirmed');
  });

  it('flags a dead microphone', () => {
    const a = analyse(makeDump({ seconds: 60, at: () => ({ micRms: 0, farRms: 0.08 }) }));
    expect(a.ids).toContain('mic-dead');
    expect(a.verdict('customer-cant-hear').status).toBe('confirmed');
  });

  it('detects packet stalls', () => {
    const a = analyse(makeDump({ seconds: 30, at: (i) => (i > 10 && i < 20 ? { ...talk(i), outPackets: 0 } : talk(i)) }));
    expect(a.ids).toContain('out-stall');
  });

  it('detects a dropped call', () => {
    const a = analyse(makeDump({ seconds: 30, at: talk, close: false, events: [[25, 'iceconnectionstatechange', 'disconnected'], [30, 'iceconnectionstatechange', 'failed']] }));
    expect(a.ids).toContain('dropped');
    expect(a.verdict('dropped').status).toBe('confirmed');
  });

  it('detects a reconnect', () => {
    const a = analyse(makeDump({ seconds: 30, at: talk, events: [[10, 'iceconnectionstatechange', 'disconnected'], [14, 'iceconnectionstatechange', 'connected']] }));
    expect(a.ids).toContain('reconnects');
    expect(a.ids).not.toContain('dropped');
  });

  it('warns about TURN over TCP, VPN, Bluetooth and latency', () => {
    const a = analyse(makeDump({ seconds: 30, at: (i) => ({ ...talk(i), rttMs: 450 }), local: { candidateType: 'relay', relayProtocol: 'tcp', networkType: 'vpn' }, deviceLabel: 'AirPods Pro (Bluetooth)' }));
    expect(a.ids).toEqual(expect.arrayContaining(['turn-tcp', 'vpn', 'bluetooth', 'rtt']));
    expect(a.verdict('delay').status).toBe('confirmed');
  });

  it('recognises hold and talking while muted', () => {
    const a = analyse(makeDump({ seconds: 200, at: (i) => (i < 20 ? talk(i) : i < 190 ? { micEnabled: false } : { micEnabled: false, farRms: 0.08 }) }));
    expect(a.ids).toEqual(expect.arrayContaining(['hold', 'far-while-muted', 'muted']));
    expect(a.verdict('customer-cant-hear').status).toBe('likely');
  });

  it('reports playout glitches as a local device problem', () => {
    const a = analyse(makeDump({ seconds: 30, at: (i) => ({ ...talk(i), glitchMs: i === 15 ? 120 : 0 }) }));
    expect(a.ids).toContain('playout');
  });
});

describe('AI round-trip', () => {
  const a = analyse(makeDump({ seconds: 60, at: talk }));

  it('builds a prompt with the issue, schema and masked IPs', () => {
    const p = buildPrompt(a.dump, a.m, a.d, 'choppy', 'customer said it was robotic');
    expect(p).toContain('Choppy, robotic');
    expect(p).toContain('customer said it was robotic');
    expect(p).toContain('"rootCause"');
    expect(p).not.toContain('203.0.113.50');
    expect(p).toContain('203.0.x.x');
  });

  it('accepts a fenced reply and drops bad time ranges', () => {
    const r = parseAiReply('```json\n{"verdict":"Clean","rootCause":{"title":"Carrier","confidence":"medium","explanation":"x"},"hypotheses":[{"title":"h","confidence":"bogus","evidence":["a"],"timeRanges":[{"from":"0:10","to":"0:20"},{"from":"soon","to":"later"}]}]}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reply.hypotheses[0].confidence).toBe('low');
      expect(r.reply.hypotheses[0].timeRanges).toEqual([{ from: '0:10', to: '0:20' }]);
    }
  });

  it('explains what is wrong with an unusable reply', () => {
    expect(parseAiReply('Sure! Here is my analysis.')).toMatchObject({ ok: false });
    expect(parseAiReply('{"verdict": ')).toMatchObject({ ok: false });
    expect(parseAiReply('{"foo": 1}')).toMatchObject({ ok: false });
  });

  it('accepts a real reply whose quotes were smartened on copy/paste', () => {
    const text = readFileSync(new URL('./fixtures/ai-reply-smart-quotes.txt', import.meta.url), 'utf8');
    expect(text).toContain('“verdict”');
    const r = parseAiReply(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.rootCause.title).toBe('Agent stayed muted after the far end came back');
    expect(r.reply.hypotheses).toHaveLength(5);
    expect(r.reply.hypotheses[2].timeRanges).toHaveLength(4);
    expect(r.reply.nextSteps[0].owner).toBe('sprinklr');
    expect(r.reply.verdict).toMatch(/^The agent’s network/); // apostrophes inside text are kept
  });

  it('keeps quotation marks inside text while repairing delimiters', () => {
    const fixed = repairJson('{“a”: “she said “hold on” and left”, “b”: [1, 2,],}');
    expect(JSON.parse(fixed)).toEqual({ a: 'she said “hold on” and left', b: [1, 2] });
    expect(JSON.parse(repairJson('{“a”:\u00a0“x \\“y\\” z”}'))).toEqual({ a: 'x "y" z' });
  });

  it('allows "end" as the end of an AI time range', () => {
    const r = parseAiReply('{"verdict":"v","hypotheses":[{"title":"h","timeRanges":[{"from":"5:35","to":"end"}]}]}');
    expect(r.ok && r.reply.hypotheses[0].timeRanges).toEqual([{ from: '5:35', to: 'end' }]);
  });

  it('parses clock strings', () => {
    expect(parseClock('4:07')).toBe(247_000);
    expect(parseClock('1:02:33')).toBe(3_753_000);
    expect(parseClock('later')).toBeNull();
  });
});

describe('redaction', () => {
  it('masks IPs', () => {
    expect(maskIp('10.20.30.40')).toBe('10.20.x.x');
    expect(maskIpsInText('from 10.20.30.40 to 198.51.100.20')).toBe('from 10.20.x.x to 198.51.x.x');
  });
});

// Real dumps live in samples/ (gitignored); these run only where they exist.
// Synthetic dumps use RFC 5737 documentation addresses, never real ones.
const LONG = 'samples/long-call.json';
const EMPTY = 'samples/empty-case104.json';

describe.skipIf(!existsSync(LONG))('real dump: 34-minute call', () => {
  const a = analyse(existsSync(LONG) ? readFileSync(LONG, 'utf8') : '{}');

  it('finds a clean network and the hold-like stretch', () => {
    expect(a.ids).toEqual(expect.arrayContaining(['clean-in', 'clean-out', 'direct', 'hold', 'muted', 'narrowband', 'cadence']));
    expect(a.ids.some((id) => id.startsWith('refresh-'))).toBe(true);
    const hold = a.d.findings.find((f) => f.id === 'hold')!;
    expect(hold.ranges.reduce((s, r) => s + r.to - r.from, 0)).toBeGreaterThan(25 * 60_000);
    expect(a.d.summary.endedBy).toMatch(/Closed normally/);
    expect(a.d.summary.mosIn).toBeGreaterThan(4);
  });

  it('says the mute ran to the end of the call instead of naming a fake unmute time', () => {
    const muted = a.d.findings.find((f) => f.id === 'muted')!;
    expect(muted.evidence[0]).toMatch(/5:35–end of call/);
    expect(buildPrompt(a.dump, a.m, a.d, 'none', '')).toMatch(/"5:35-end"/);
  });

  it('does not invent network problems', () => {
    expect(a.ids).not.toContain('loss-in');
    expect(a.ids).not.toContain('loss-out');
    expect(a.ids).not.toContain('dropped');
    expect(a.verdict('choppy').status).toBe('not-found');
  });
});

describe.skipIf(!existsSync(EMPTY))('real dump: empty participant', () => {
  it('says there is no data', () => {
    const a = analyse(existsSync(EMPTY) ? readFileSync(EMPTY, 'utf8') : '{}');
    expect(a.ids).toEqual(['no-stats']);
    expect(a.verdict('choppy').status).toBe('not-visible');
  });
});
