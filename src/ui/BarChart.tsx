/**
 * A small SVG column chart: one series or a stack, with a hover/keyboard
 * tooltip and a table view.
 *
 * Hand-rolled rather than a chart library: the app ships as one offline HTML
 * file, and a column chart is ~200 lines. The look follows the dataviz rules
 * the rest of the stats screen uses — columns capped at 24px with a 4px
 * rounded top and a square base, a 2px surface gap between stacked segments,
 * hairline gridlines, text in text colors (never the series color), a legend
 * only when there's more than one series, and a table so no value is
 * reachable only by hovering.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { niceScale } from '../stats';

export interface BarSeries {
  name: string;
  /** A CSS color, normally one of the `--viz-*` tokens. */
  color: string;
}

export interface BarDatum {
  /** Tooltip / table heading, e.g. "Tue, Sep 22". */
  label: string;
  /** Axis label under the column; empty to leave this column unlabeled. */
  tick: string;
  /** One value per series, in series order (bottom of the stack first). */
  values: number[];
}

export interface BarChartProps {
  series: BarSeries[];
  data: BarDatum[];
  /** What the chart shows, for screen readers. */
  label: string;
  /** "12 reviews" — used in the tooltip total and the table. */
  unit: (n: number) => string;
  height?: number;
  /** Heading for the table's first column. */
  period?: string;
}

const M = { top: 10, right: 6, bottom: 22, left: 34 };
const GAP = 2;
const MAX_BAR = 24;
const RADIUS = 4;

/** A column segment with rounded top corners only; the base stays square on the baseline. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function BarChart({ series, data, label, unit, height = 180, period = 'Day' }: BarChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();

  // Resize observers report before paint, including once on `observe`, so the
  // first frame is already drawn at the real width.
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width) || 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const { top, step } = niceScale(Math.max(0, ...totals));
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(1, Math.min(MAX_BAR, band - GAP));
  const y = (v: number) => M.top + plotH - (v / top) * plotH;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!data.length) return;
    const last = data.length - 1;
    const cur = active ?? last;
    const next =
      e.key === 'ArrowLeft' ? Math.max(0, cur - 1)
      : e.key === 'ArrowRight' ? Math.min(last, cur + 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  }

  const tip = active !== null ? data[active] : null;
  const tipX = active !== null ? M.left + band * active + band / 2 : 0;

  return (
    <div className="chart">
      {series.length > 1 ? (
        <ul className="chart__legend" aria-hidden="true">
          {series.map((s) => (
            <li key={s.name}>
              <span className="chart__swatch" style={{ background: s.color }} />
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}

      <div
        ref={wrap}
        className="chart__plot"
        tabIndex={0}
        role="group"
        aria-labelledby={titleId}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? data.length - 1)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <span id={titleId} className="sr-only">
          {label}. Use the arrow keys to read each column; a table view follows.
        </span>
        <svg width={width} height={height} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} className="chart__grid" />
              <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="chart__axis">
                {t.toLocaleString()}
              </text>
            </g>
          ))}

          {active !== null ? (
            <rect x={M.left + band * active} y={M.top} width={band} height={plotH} className="chart__hover" />
          ) : null}

          {data.map((d, i) => {
            const x = M.left + band * i + (band - barW) / 2;
            let base = 0;
            const lastNonZero = d.values.reduce((last, v, k) => (v > 0 ? k : last), -1);
            return (
              <g key={i}>
                {d.values.map((v, k) => {
                  if (v <= 0) return null;
                  const y0 = y(base);
                  base += v;
                  const y1 = y(base);
                  // The gap comes off the top of every segment that has another above it.
                  const h = Math.max(0.5, y0 - y1 - (k < lastNonZero ? GAP : 0));
                  const top = y0 - h;
                  return k === lastNonZero ? (
                    <path key={k} d={topRounded(x, top, barW, h, RADIUS)} fill={series[k].color} />
                  ) : (
                    <rect key={k} x={x} y={top} width={barW} height={h} fill={series[k].color} />
                  );
                })}
                {d.tick ? (
                  <text x={M.left + band * i + band / 2} y={height - 6} textAnchor="middle" className="chart__axis">
                    {d.tick}
                  </text>
                ) : null}
                {/* Hit target: the whole column band, not just the painted bar. */}
                <rect
                  x={M.left + band * i}
                  y={M.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setActive(i)}
                />
              </g>
            );
          })}

          <line x1={M.left} x2={M.left + plotW} y1={y(0)} y2={y(0)} className="chart__baseline" />
        </svg>

        {tip ? (
          <div
            className="chart__tip"
            role="status"
            style={{
              left: tipX,
              transform: tipX > width * 0.6 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <div className="chart__tip-head">{tip.label}</div>
            {series.length > 1 ? (
              <>
                {series.map((s, k) => (
                  <div key={s.name} className="chart__tip-row">
                    <span className="chart__key" style={{ background: s.color }} />
                    <strong>{tip.values[k].toLocaleString()}</strong> {s.name.toLowerCase()}
                  </div>
                ))}
                <div className="chart__tip-total">{unit(totals[active!])}</div>
              </>
            ) : (
              <div className="chart__tip-row">
                <strong>{unit(tip.values[0])}</strong>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <details className="chart__table">
        <summary className="small faint">Table</summary>
        <table>
          <thead>
            <tr>
              <th>{period}</th>
              {series.map((s) => (
                <th key={s.name}>{s.name}</th>
              ))}
              {series.length > 1 ? <th>Total</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.map((d, i) => (
              <tr key={i}>
                <td>{d.label}</td>
                {d.values.map((v, k) => (
                  <td key={k}>{v.toLocaleString()}</td>
                ))}
                {series.length > 1 ? <td>{totals[i].toLocaleString()}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
