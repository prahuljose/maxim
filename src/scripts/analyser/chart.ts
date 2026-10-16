import { elapsed } from '../../lib/webrtc/format';

export interface Band {
  from: number;
  to: number;
  cls: string;
  label?: string;
}

export interface LineSeries {
  label: string;
  cls: string;
  values: (number | null)[];
}

export interface LineSpec {
  kind: 'line';
  title: string;
  note?: string;
  t: number[];
  series: LineSeries[];
  format: (v: number) => string;
  yMin?: number;
  yMax?: number;
  /** Never let the axis shrink below this, so a flat clean line doesn't look like a crisis. */
  yFloor?: number;
  thresholds?: { y: number; label: string; cls: string }[];
  bands?: Band[];
}

export interface Lane {
  label: string;
  spans: Band[];
  markers?: { t: number; cls: string; label: string }[];
}

export interface LaneSpec {
  kind: 'lanes';
  title: string;
  note?: string;
  lanes: Lane[];
}

export type ChartSpec = LineSpec | LaneSpec;

interface Mounted {
  el: HTMLElement;
  lastWidth: number;
  spec: ChartSpec;
  draw: () => void;
  cursor: (t: number | null) => void;
}

/**
 * A small SVG charting layer. Every chart on the page shares one time axis and one cursor,
 * so hovering any chart lines up the same moment across all of them.
 */
export class Charts {
  private mounted: Mounted[] = [];
  private observer: ResizeObserver;
  private extraBands: Band[] = [];

  constructor(
    private start: number,
    private end: number,
  ) {
    this.observer = new ResizeObserver((entries) => {
      // Redraw on width changes only; drawing itself changes the height.
      for (const e of entries) {
        const m = this.mounted.find((x) => x.el === e.target);
        if (m && m.el.clientWidth !== m.lastWidth) m.draw();
      }
    });
  }

  destroy() {
    this.observer.disconnect();
    this.mounted = [];
  }

  /** Bands drawn on every chart (hovered finding, AI time ranges). */
  setBands(bands: Band[]) {
    this.extraBands = bands;
    for (const m of this.mounted) m.draw();
  }

  mount(el: HTMLElement, spec: ChartSpec) {
    const m: Mounted = { el, lastWidth: -1, spec, draw: () => {}, cursor: () => {} };
    m.draw = () => {
      m.lastWidth = el.clientWidth;
      if (spec.kind === 'line') this.drawLine(m, spec);
      else this.drawLanes(m, spec);
    };
    this.mounted.push(m);
    this.observer.observe(el);
    m.draw();
  }

  private broadcast(t: number | null) {
    for (const m of this.mounted) m.cursor(t);
  }

  private x(width: number, L: number, R: number) {
    const span = Math.max(1, this.end - this.start);
    return {
      of: (t: number) => L + ((t - this.start) / span) * (width - L - R),
      inv: (px: number) => this.start + ((px - L) / (width - L - R)) * span,
    };
  }

  private ticks(width: number) {
    const span = this.end - this.start;
    const target = Math.max(3, Math.floor(width / 90));
    const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
    const step = steps.find((s) => span / s <= target) ?? 3600_000;
    const out: number[] = [];
    for (let v = 0; v <= span; v += step) out.push(this.start + v);
    return out;
  }

  private bandsSvg(bands: Band[], xOf: (t: number) => number, top: number, h: number) {
    return bands
      .map((b) => {
        const x0 = xOf(b.from);
        const w = Math.max(2, xOf(b.to) - x0);
        return `<rect class="band ${b.cls}" x="${x0}" y="${top}" width="${w}" height="${h}"><title>${esc(b.label ?? '')}</title></rect>`;
      })
      .join('');
  }

  private wireCursor(m: Mounted, svg: SVGSVGElement, width: number, L: number, R: number, onCursor: (t: number | null, px: number) => void) {
    const { of, inv } = this.x(width, L, R);
    m.cursor = (t) => onCursor(t, t === null ? 0 : of(t));
    const move = (clientX: number) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * width;
      if (px < L || px > width - R) return this.broadcast(null);
      this.broadcast(inv(px));
    };
    svg.addEventListener('pointermove', (e) => move(e.clientX));
    svg.addEventListener('pointerleave', () => this.broadcast(null));
  }

  private drawLine(m: Mounted, spec: LineSpec) {
    const width = Math.max(280, m.el.clientWidth);
    const H = 190;
    const R = 12, T = 10, B = 26;
    const ih = H - T - B;

    const all = spec.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
    const thr = (spec.thresholds ?? []).map((t) => t.y);
    let yMin = spec.yMin ?? Math.min(0, ...all);
    let yMax = spec.yMax ?? Math.max(spec.yFloor ?? 1, ...all, ...thr.map((y) => y * 1.1));
    if (yMax <= yMin) yMax = yMin + 1;
    if (spec.yMax === undefined) yMax = niceCeil(yMax);
    const y = (v: number) => T + ih * (1 - (v - yMin) / (yMax - yMin));
    // Left margin fits the widest y-axis label.
    const yLabels = [0, 1, 2, 3, 4].map((i) => spec.format(yMin + ((yMax - yMin) * i) / 4));
    const L = 14 + Math.max(...yLabels.map((l) => l.length)) * 6.6;
    const { of } = this.x(width, L, R);

    let out = '';
    out += this.bandsSvg([...(spec.bands ?? []), ...this.extraBands], of, T, ih);
    for (let i = 0; i <= 4; i++) {
      const v = yMin + ((yMax - yMin) * i) / 4;
      out += `<line class="grid" x1="${L}" x2="${width - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(spec.format(v))}</text>`;
    }
    for (const t of this.ticks(width)) {
      out += `<text class="axis" x="${of(t)}" y="${H - 6}" text-anchor="middle">${elapsed(t - this.start)}</text>`;
    }
    for (const th of spec.thresholds ?? []) {
      if (th.y > yMax) continue;
      out += `<line class="thr ${th.cls}" x1="${L}" x2="${width - R}" y1="${y(th.y)}" y2="${y(th.y)}"/><text class="thr-label ${th.cls}" x="${width - R - 4}" y="${y(th.y) - 4}" text-anchor="end">${esc(th.label)}</text>`;
    }
    for (const s of spec.series) {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${of(spec.t[i]).toFixed(1)},${y(Math.min(yMax, Math.max(yMin, v))).toFixed(1)}`;
        pen = true;
      });
      out += `<path class="line ${s.cls}" d="${d}"/>`;
    }
    out += `<line class="cursor" x1="0" x2="0" y1="${T}" y2="${T + ih}" visibility="hidden"/>`;
    for (const s of spec.series) out += `<circle class="dot ${s.cls}" r="3.5" visibility="hidden"/>`;

    m.el.innerHTML = `<svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}">${out}</svg><div class="tip" hidden></div>`;
    const svg = m.el.querySelector('svg')!;
    const cursor = svg.querySelector('.cursor')!;
    const dots = [...svg.querySelectorAll('.dot')];
    const tip = m.el.querySelector('.tip') as HTMLElement;

    this.wireCursor(m, svg, width, L, R, (t, px) => {
      if (t === null) {
        cursor.setAttribute('visibility', 'hidden');
        dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
        tip.hidden = true;
        return;
      }
      const i = nearestIdx(spec.t, t);
      cursor.setAttribute('x1', String(px));
      cursor.setAttribute('x2', String(px));
      cursor.setAttribute('visibility', 'visible');
      const rows: string[] = [];
      spec.series.forEach((s, k) => {
        const v = s.values[i];
        const dot = dots[k];
        if (v === null || v === undefined || !Number.isFinite(v)) {
          dot.setAttribute('visibility', 'hidden');
          rows.push(`<span><i class="sw ${s.cls}"></i>${esc(s.label)} <b>—</b></span>`);
          return;
        }
        dot.setAttribute('cx', String(of(spec.t[i])));
        dot.setAttribute('cy', String(y(Math.min(yMax, Math.max(yMin, v)))));
        dot.setAttribute('visibility', 'visible');
        rows.push(`<span><i class="sw ${s.cls}"></i>${esc(s.label)} <b>${esc(spec.format(v))}</b></span>`);
      });
      tip.innerHTML = `<strong>${elapsed(spec.t[i] - this.start)}</strong>${rows.join('')}`;
      tip.hidden = false;
      const left = (px / width) * m.el.clientWidth;
      tip.style.left = `${Math.min(left + 12, m.el.clientWidth - tip.offsetWidth - 4)}px`;
    });
  }

  private drawLanes(m: Mounted, spec: LaneSpec) {
    const width = Math.max(280, m.el.clientWidth);
    const laneH = 22, gap = 8, L = 92, R = 12, T = 6;
    const H = T + spec.lanes.length * (laneH + gap) + 22;
    const { of } = this.x(width, L, R);
    let out = this.bandsSvg(this.extraBands, of, T, H - T - 22);
    spec.lanes.forEach((lane, i) => {
      const y = T + i * (laneH + gap);
      out += `<text class="lane-label" x="${L - 10}" y="${y + laneH / 2 + 4}" text-anchor="end">${esc(lane.label)}</text>`;
      out += `<rect class="lane-bg" x="${L}" y="${y}" width="${width - L - R}" height="${laneH}" rx="4"/>`;
      for (const s of lane.spans) {
        const x0 = of(s.from);
        out += `<rect class="span ${s.cls}" x="${x0}" y="${y + 3}" width="${Math.max(1.5, of(s.to) - x0)}" height="${laneH - 6}" rx="2"><title>${esc(s.label ?? '')}</title></rect>`;
      }
      for (const mk of lane.markers ?? []) {
        const x = of(mk.t);
        out += `<g class="marker ${mk.cls}"><line x1="${x}" x2="${x}" y1="${y + 2}" y2="${y + laneH - 2}"/><circle cx="${x}" cy="${y + laneH / 2}" r="4"/><title>${esc(mk.label)}</title></g>`;
      }
    });
    for (const t of this.ticks(width)) out += `<text class="axis" x="${of(t)}" y="${H - 6}" text-anchor="middle">${elapsed(t - this.start)}</text>`;
    out += `<line class="cursor" x1="0" x2="0" y1="${T}" y2="${H - 22}" visibility="hidden"/>`;
    m.el.innerHTML = `<svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}">${out}</svg><div class="tip" hidden></div>`;

    const svg = m.el.querySelector('svg')!;
    const cursor = svg.querySelector('.cursor')!;
    const tip = m.el.querySelector('.tip') as HTMLElement;
    this.wireCursor(m, svg, width, L, R, (t, px) => {
      if (t === null) {
        cursor.setAttribute('visibility', 'hidden');
        tip.hidden = true;
        return;
      }
      cursor.setAttribute('x1', String(px));
      cursor.setAttribute('x2', String(px));
      cursor.setAttribute('visibility', 'visible');
      const rows = spec.lanes.map((lane) => {
        const hit = lane.spans.filter((s) => s.from <= t && s.to >= t).map((s) => s.label).filter(Boolean);
        return `<span>${esc(lane.label)} <b>${esc(hit.join(', ') || '—')}</b></span>`;
      });
      tip.innerHTML = `<strong>${elapsed(t - this.start)}</strong>${rows.join('')}`;
      tip.hidden = false;
      const left = (px / width) * m.el.clientWidth;
      tip.style.left = `${Math.min(left + 12, m.el.clientWidth - tip.offsetWidth - 4)}px`;
    });
  }
}

function nearestIdx(ts: number[], t: number) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < ts.length; i++) {
    const d = Math.abs(ts[i] - t);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
