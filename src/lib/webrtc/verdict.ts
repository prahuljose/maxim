import type { Diagnosis, Finding } from './diagnose';
import type { CallMetrics } from './metrics';

export const ISSUES = [
  { id: 'none', label: 'Not sure — check everything' },
  { id: 'choppy', label: 'Choppy, robotic or breaking-up audio' },
  { id: 'agent-cant-hear', label: 'One-way audio — agent couldn’t hear the customer' },
  { id: 'customer-cant-hear', label: 'One-way audio — customer couldn’t hear the agent' },
  { id: 'no-audio', label: 'No audio either way' },
  { id: 'dropped', label: 'Call dropped or disconnected' },
  { id: 'delay', label: 'Delay, lag or talking over each other' },
  { id: 'echo', label: 'Echo' },
  { id: 'noise', label: 'Static, crackling or background noise' },
  { id: 'low-volume', label: 'Low or fading volume' },
] as const;

export type IssueId = (typeof ISSUES)[number]['id'];

export type VerdictStatus = 'confirmed' | 'likely' | 'review' | 'not-found' | 'not-visible' | 'none';

export interface Verdict {
  issue: IssueId;
  status: VerdictStatus;
  headline: string;
  reasons: string[];
  findingIds: string[];
  nextSteps: string[];
}

const has = (d: Diagnosis, ...ids: string[]) => d.findings.filter((f) => ids.some((id) => f.id === id || f.id.startsWith(`${id}-`)));
const bad = (fs: Finding[]) => fs.filter((f) => f.severity === 'critical' || f.severity === 'warning');
const cite = (fs: Finding[]) => fs.map((f) => `${f.title} — ${f.evidence[0] ?? ''}`.replace(/ — $/, ''));

/** What the dump says about the issue someone reported. */
export function verdictFor(issue: IssueId, d: Diagnosis, m: CallMetrics): Verdict {
  const base = { issue, findingIds: [] as string[], reasons: [] as string[], nextSteps: [] as string[] };
  if (!m.hasStats) {
    return { ...base, status: 'not-visible', headline: 'This dump has no call data, so it can’t confirm or rule anything out.', nextSteps: ['Export the agent’s participant (the browser leg) from the Voice Debug Console and try again.'] };
  }
  const out = (status: VerdictStatus, headline: string, fs: Finding[], nextSteps: string[], extra: string[] = []): Verdict => ({
    issue,
    status,
    headline,
    reasons: [...cite(fs), ...extra],
    findingIds: fs.map((f) => f.id),
    nextSteps,
  });

  const carrierSteps = [
    'The agent’s browser leg was clean, so look past it: the PSTN/carrier leg and the Sprinklr media server.',
    'Check the call’s carrier/SIP trace in Sprinklr, or raise it with Sprinklr support quoting the conversation ID.',
  ];

  switch (issue) {
    case 'none': {
      const b = bad(d.findings);
      return b.length
        ? out('review', `${b.length} thing${b.length > 1 ? 's' : ''} on this call worth a look.`, b, [])
        : out('none', 'No problems found on the agent’s side of this call.', [], [], ['Network, audio and connection checks all passed.']);
    }

    case 'choppy': {
      const inSide = bad(has(d, 'loss-in', 'jitter-in', 'conceal'));
      const outSide = bad(has(d, 'loss-out', 'jitter-out'));
      const local = bad(has(d, 'playout', 'bluetooth', 'reconnects', 'pair-switch', 'turn-tcp'));
      if (inSide.length || outSide.length) {
        const who = inSide.length && outSide.length ? 'in both directions' : inSide.length ? 'on what the agent heard' : 'on what the customer heard from the agent';
        return out('confirmed', `The network was dropping or delaying audio ${who}.`, [...inSide, ...outSide, ...local], [
          'Move the agent to wired Ethernet if they were on Wi-Fi, and check for VPN or heavy uploads on the same connection.',
          'If several agents on one site are affected, check the site’s internet link and firewall.',
        ]);
      }
      if (local.length) return out('likely', 'Likely a local problem on the agent’s machine, not the network.', local, ['Check CPU load and the headset connection; try a wired/USB headset.']);
      return out('not-found', 'Not seen on the agent’s side. Loss, jitter and concealment were all within normal limits.', has(d, 'clean-in', 'clean-out'), carrierSteps);
    }

    case 'agent-cant-hear': {
      const hard = has(d, 'in-stall', 'far-silent', 'never-connected');
      if (hard.length) return out('confirmed', 'No usable audio reached the agent.', hard, ['If packets arrived but were silent, the customer’s audio was lost before the media server: check the carrier/PSTN leg.', 'If no packets arrived, check the firewall isn’t closing the UDP flow.']);
      const hold = has(d, 'hold', 'dead-air');
      if (hold.length) return out('likely', 'Partly: there were long stretches where nothing audible arrived from the far end.', hold, ['Confirm with the agent whether the call was on hold at those times.', ...carrierSteps], ['Outside those stretches the far end was audible.']);
      return out('not-found', 'Not seen. Far-end audio was arriving and audible during the call.', has(d, 'clean-in'), carrierSteps, [`Far end audible for ${Math.round(d.summary.talkMs.far / 1000 + d.summary.talkMs.both / 1000)} s.`]);
    }

    case 'customer-cant-hear': {
      const hard = has(d, 'out-stall', 'mic-dead', 'gum');
      if (hard.length) return out('confirmed', 'The agent’s audio wasn’t getting out.', hard, ['Check the selected microphone in the browser and OS, and any hardware mute switch on the headset.']);
      const muteIssues = has(d, 'far-while-muted', 'muted', 'hold');
      if (bad(muteIssues).length) return out('likely', 'The agent was muted while the customer was speaking.', muteIssues, ['Check whether the agent knew they were muted or on hold at those times.']);
      const net = bad(has(d, 'loss-out', 'jitter-out'));
      if (net.length) return out('likely', 'Partly: the agent’s outgoing audio was degraded by the network.', net, ['Check the agent’s upload connection.']);
      return out('not-found', 'Not seen. The agent’s mic was picking up sound and packets were leaving cleanly.', has(d, 'clean-out'), carrierSteps);
    }

    case 'no-audio': {
      const hard = has(d, 'never-connected', 'in-stall', 'out-stall', 'mic-dead', 'far-silent', 'dead-air', 'gum');
      if (hard.length) return out('confirmed', 'Audio wasn’t flowing.', hard, ['Start with the connection path: a firewall blocking UDP is the most common cause of no audio at all.']);
      return out('not-found', 'Not seen. Audio flowed in both directions.', has(d, 'clean-in', 'clean-out'), carrierSteps);
    }

    case 'dropped': {
      const hard = has(d, 'dropped', 'reconnects', 'pair-switch', 'never-connected');
      if (hard.length) return out('confirmed', 'The connection broke.', hard, ['Check Wi-Fi stability, VPN reconnects and power-saving settings on the agent’s machine.']);
      return out('not-found', 'Not a network drop on the agent’s side.', [], ['Something ended the call deliberately — the agent, the customer, a transfer, or the carrier. Check the Sprinklr conversation log for who hung up.'], [d.summary.endedBy]);
    }

    case 'delay': {
      const hard = bad(has(d, 'rtt', 'buffer', 'jitter-in', 'jitter-out', 'turn-tcp', 'vpn'));
      if (hard.length) return out('confirmed', 'There was measurable extra delay.', hard, ['Delay over ~300 ms round trip makes people talk over each other. Check VPN, TURN/TCP relaying, and the agent’s distance from the media server region.']);
      return out('not-found', 'Not seen on the agent’s side. Latency stayed low.', has(d, 'rtt-ok'), ['PSTN legs and international routing add delay the browser can’t see. Check where the call was routed.']);
    }

    case 'echo': {
      const hints = has(d, 'builtin-mic', 'bluetooth');
      const erl = m.echo.erle;
      return out(
        hints.length ? 'likely' : 'not-visible',
        hints.length ? 'Possible: the agent’s setup is prone to echo.' : 'Echo can’t be measured from these stats.',
        hints,
        ['If the customer heard echo of themselves, the agent’s speaker audio was leaking into the mic: use a headset and lower speaker volume.', 'If the agent heard echo, it usually comes from the customer’s handset or speakerphone.'],
        erl !== null ? [`Browser echo-canceller enhancement reported ${erl.toFixed(1)} dB (informational).`] : [],
      );
    }

    case 'noise': {
      const local = bad(has(d, 'playout', 'bluetooth', 'conceal'));
      if (local.length) return out('likely', 'Possibly related: audio glitches were measured.', local, ['Crackles from the agent’s own headset point at the PC (CPU, USB, drivers).']);
      return out('not-visible', 'Background noise and static are in the audio itself, which these stats don’t capture.', [], ['Listen to the call recording to tell which side the noise came from.', 'Static on a clean network usually comes from the phone line or a damaged headset cable.']);
    }

    case 'low-volume': {
      const farLevels = m.samples.filter((s) => (s.farRms ?? 0) > 0.005).map((s) => s.farRms!);
      const micLevels = m.samples.filter((s) => (s.micRms ?? 0) > 0.005 && s.micEnabled !== false).map((s) => s.micRms!);
      const med = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null);
      const fm = med(farLevels);
      const mm = med(micLevels);
      const extra = [
        fm !== null ? `Far-end speech level (median RMS): ${fm.toFixed(3)}` : 'Far end barely audible in the stats.',
        mm !== null ? `Agent mic speech level (median RMS): ${mm.toFixed(3)}` : 'Agent mic barely audible in the stats.',
      ];
      const quiet = (fm !== null && fm < 0.01) || (mm !== null && mm < 0.008);
      return out(
        quiet ? 'likely' : 'not-found',
        quiet ? 'Possible: measured speech levels were low.' : 'Speech levels looked normal.',
        [],
        ['Check the agent’s mic gain in the OS and headset software.', 'Volume is relative — compare with a known-good call from the same setup.'],
        extra,
      );
    }
  }
}
