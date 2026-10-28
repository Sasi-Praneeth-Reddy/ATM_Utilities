// Visualizations for the Market module (Storage tracker + Real-estate benchmarks).
// Plain HTML/SVG, no chart library, same look as the Leads charts.
import { useState } from 'react';
import { Card } from '../leads/LeadsCharts';

export { Card };

export const money = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `$${Math.round(v).toLocaleString()}`);
export const moneyShort = (v) => (v >= 1000000 ? `$${(v / 1000000).toFixed(2)}M` : v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

const MUTED = '#718096';
const TRACK = 'var(--bg-subtle, #edf2f7)';

function niceMax(v) {
  if (v <= 10) return 10;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export function Empty({ children = 'Nothing matches the current filters.' }) {
  return <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: '12px', color: MUTED }}>{children}</div>;
}

/** Horizontal bars. rows: [{ key, label, value, sub?, color }] */
export function HBars({ rows, format = money, max: maxIn, labelWidth = 130 }) {
  if (!rows.length) return <Empty />;
  const max = maxIn || Math.max(...rows.map((r) => r.value), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
      {rows.map((r) => (
        <div key={r.key ?? r.label} title={`${r.label}: ${format(r.value)}${r.sub ? ` · ${r.sub}` : ''}`} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ width: `${labelWidth}px`, flex: 'none', fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
          <div style={{ flex: 1, height: '14px', backgroundColor: TRACK, borderRadius: '7px', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, height: '100%', backgroundColor: r.color || '#3182ce', borderRadius: '7px' }} />
          </div>
          <div style={{ width: '92px', flex: 'none', textAlign: 'right', fontSize: '12px', fontWeight: 700 }}>
            {format(r.value)}
            {r.sub && <div style={{ fontSize: '10px', fontWeight: 500, color: MUTED }}>{r.sub}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Min–max span with an average marker, per row. rows: [{ key, label, color, min, avg, max, count }] */
export function RangeBars({ rows, labelWidth = 130 }) {
  if (!rows.length) return <Empty />;
  const hi = niceMax(Math.max(...rows.map((r) => r.max), 1));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {rows.map((r) => (
          <div key={r.key ?? r.label} title={`${r.label}\nLowest ${money(r.min)} · Average ${money(r.avg)} · Highest ${money(r.max)}\n${r.count} facilities`} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: `${labelWidth}px`, flex: 'none', fontSize: '12px', fontWeight: 600 }}>
              {r.label}
              <div style={{ fontSize: '10px', fontWeight: 500, color: MUTED }}>{r.count} {r.count === 1 ? 'facility' : 'facilities'}</div>
            </div>
            <div style={{ position: 'relative', flex: 1, height: '22px' }}>
              {ticks.map((t) => (
                <div key={t} style={{ position: 'absolute', left: `${t * 100}%`, top: 0, bottom: 0, borderLeft: '1px dashed #e2e8f0' }} />
              ))}
              <div style={{ position: 'absolute', top: '8px', height: '6px', left: `${(r.min / hi) * 100}%`, width: `${Math.max(1, ((r.max - r.min) / hi) * 100)}%`, backgroundColor: r.color, opacity: 0.35, borderRadius: '3px' }} />
              <div style={{ position: 'absolute', top: '3px', width: '4px', height: '16px', left: `calc(${(r.avg / hi) * 100}% - 2px)`, backgroundColor: r.color, borderRadius: '2px' }} />
            </div>
            <div style={{ width: '120px', flex: 'none', fontSize: '11px', textAlign: 'right', color: MUTED }}>
              <b style={{ color: 'inherit', fontSize: '12px' }}>{money(r.avg)}</b> avg<br />{money(r.min)}–{money(r.max)}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', marginLeft: `${labelWidth + 10}px`, marginRight: '130px', justifyContent: 'space-between', fontSize: '10px', color: MUTED, marginTop: '6px' }}>
        {ticks.map((t) => <span key={t}>${Math.round(hi * t)}</span>)}
      </div>
    </div>
  );
}

/** Histogram of numeric values. */
export function Histogram({ values, bins = 10, color = '#3182ce', format = money, markers = [] }) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return <Empty />;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = Math.max(hi - lo, 1);
  const width = span / bins;
  const counts = Array.from({ length: bins }, () => 0);
  v.forEach((x) => { counts[Math.min(bins - 1, Math.floor((x - lo) / width))] += 1; });
  const max = Math.max(...counts, 1);
  const H = 150;
  return (
    <div>
      <div style={{ position: 'relative', height: `${H}px`, display: 'flex', alignItems: 'flex-end', gap: '3px', borderBottom: '1px solid #cbd5e0' }}>
        {counts.map((c, i) => {
          const from = lo + i * width;
          return (
            <div key={i} title={`${format(from)} – ${format(from + width)}: ${c} facilities`} style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, marginBottom: '2px' }}>{c || ''}</span>
              <div style={{ width: '100%', height: `${(c / max) * (H - 18)}px`, backgroundColor: color, borderRadius: '3px 3px 0 0', minHeight: c ? '2px' : 0 }} />
            </div>
          );
        })}
        {markers.map((m) => (
          <div key={m.label} title={`${m.label}: ${format(m.value)}`} style={{ position: 'absolute', bottom: 0, top: 0, left: `${Math.min(100, Math.max(0, ((m.value - lo) / span) * 100))}%`, borderLeft: `2px dashed ${m.color}`, pointerEvents: 'none' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: MUTED, marginTop: '5px' }}>
        <span>{format(lo)}</span>
        <span>{format(hi)}</span>
      </div>
      {markers.length > 0 && (
        <div style={{ display: 'flex', gap: '14px', marginTop: '6px', fontSize: '11px', color: '#4a5568' }}>
          {markers.map((m) => (
            <span key={m.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '14px', borderTop: `2px dashed ${m.color}` }} />{m.label} {format(m.value)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Donut: parts = [{ key, label, color, n }] */
export function Donut({ parts, centerLabel = 'total' }) {
  const list = parts.filter((p) => p.n > 0);
  const total = list.reduce((s, p) => s + p.n, 0);
  if (!total) return <Empty />;
  const R = 62, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' }}>
      <svg width="170" height="170" viewBox="0 0 180 180" role="img" aria-label="Share by brand">
        <g transform="rotate(-90 90 90)">
          {list.map((p) => {
            const len = (p.n / total) * C;
            const el = (
              <circle key={p.key} cx="90" cy="90" r={R} fill="none" stroke={p.color} strokeWidth="26"
                strokeDasharray={`${Math.max(len - 1.5, 0)} ${C - len + 1.5}`} strokeDashoffset={-offset}>
                <title>{`${p.label}: ${p.n.toLocaleString()} (${Math.round((p.n / total) * 100)}%)`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </g>
        <text x="90" y="86" textAnchor="middle" fontSize="24" fontWeight="800" fill="currentColor">{total.toLocaleString()}</text>
        <text x="90" y="104" textAnchor="middle" fontSize="11" fill={MUTED}>{centerLabel}</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', flex: 1, minWidth: '150px' }}>
        {list.map((p) => (
          <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: p.color, flex: 'none' }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
            <b>{p.n.toLocaleString()}</b>
            <span style={{ width: '40px', textAlign: 'right', color: MUTED }}>{Math.round((p.n / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ranked list with a value bar. rows: [{ key, title, sub, value, color }] */
export function RankList({ rows, format = money, onPick }) {
  if (!rows.length) return <Empty />;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {rows.map((r, i) => (
        <li key={r.key} onClick={onPick ? () => onPick(r) : undefined} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: onPick ? 'pointer' : 'default' }}>
          <span style={{ width: '18px', fontSize: '11px', fontWeight: 700, color: MUTED, textAlign: 'right' }}>{i + 1}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
            <div style={{ height: '5px', backgroundColor: TRACK, borderRadius: '3px', marginTop: '3px' }}>
              <div style={{ width: `${(r.value / max) * 100}%`, height: '100%', backgroundColor: r.color, borderRadius: '3px' }} />
            </div>
            {r.sub && <div style={{ fontSize: '10px', color: MUTED, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</div>}
          </div>
          <b style={{ fontSize: '13px', width: '64px', textAlign: 'right' }}>{format(r.value)}</b>
        </li>
      ))}
    </ol>
  );
}

/** Multi-series line chart over shared categorical x labels.
    series: [{ key, name, color, values: [number|null per label] }] */
export function LineChart({ labels, series, format = money, height = 230, dense = false }) {
  const [hover, setHover] = useState(null);
  const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  if (!all.length || labels.length < 2) return <Empty>Not enough data for a trend yet.</Empty>;
  const W = 600, H = height, PL = 52, PR = 14, PT = 14, PB = 28;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo || hi || 1) * 0.12;
  lo = Math.max(0, lo - pad); hi += pad;
  const x = (i) => PL + (i / (labels.length - 1)) * (W - PL - PR);
  const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + (hi - lo) * t);
  const step = Math.max(1, Math.ceil(labels.length / (dense ? 12 : 8)));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" onMouseLeave={() => setHover(null)}>
        {grid.map((g) => (
          <g key={g}>
            <line x1={PL} x2={W - PR} y1={y(g)} y2={y(g)} stroke="#e2e8f0" strokeDasharray="3 3" />
            <text x={PL - 6} y={y(g) + 3} textAnchor="end" fontSize="10" fill={MUTED}>{format(g)}</text>
          </g>
        ))}
        {labels.map((l, i) => ((i % step === 0 && (labels.length - 1 - i >= step * 0.7 || i === labels.length - 1)) || i === labels.length - 1 ? (
          <text key={l} x={x(i)} y={H - 8} textAnchor={i === labels.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'} fontSize="10" fill={MUTED}>{l}</text>
        ) : null))}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v === null || v === undefined ? null : [x(i), y(v)]));
          const segs = [];
          let cur = [];
          pts.forEach((p) => { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } });
          if (cur.length) segs.push(cur);
          return (
            <g key={s.key}>
              {segs.map((seg, i) => (
                <polyline key={i} points={seg.map((p) => p.join(',')).join(' ')} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {pts.map((p, i) => (p ? <circle key={i} cx={p[0]} cy={p[1]} r={hover === i ? 5 : 3} fill={s.color} /> : null))}
            </g>
          );
        })}
        {labels.map((l, i) => (
          <rect key={l} x={x(i) - (W - PL - PR) / (labels.length - 1) / 2} y={PT} width={(W - PL - PR) / (labels.length - 1)} height={H - PT - PB} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={PT} y2={H - PB} stroke="#a0aec0" strokeDasharray="2 3" />
            {(() => {
              const lines = [labels[hover], ...series.filter((s) => s.values[hover] !== null && s.values[hover] !== undefined).map((s) => `${s.name}: ${format(s.values[hover])}`)];
              const w = Math.max(...lines.map((t) => t.length)) * 6.2 + 16;
              const bx = Math.min(Math.max(x(hover) - w / 2, PL), W - PR - w);
              return (
                <g>
                  <rect x={bx} y={PT} width={w} height={lines.length * 15 + 8} rx="5" fill="#1a202c" opacity="0.92" />
                  {lines.map((t, i) => <text key={t} x={bx + 8} y={PT + 17 + i * 15} fontSize="11" fill="#fff" fontWeight={i === 0 ? 700 : 400}>{t}</text>)}
                </g>
              );
            })()}
          </g>
        )}
      </svg>
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: '16px', marginTop: '4px', fontSize: '11px', color: '#4a5568', flexWrap: 'wrap' }}>
          {series.map((s) => (
            <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '14px', height: '3px', borderRadius: '2px', backgroundColor: s.color }} />{s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Two bars per category (e.g. sales vs new listings). rows: [{ key, label, a, b }] */
export function PairedColumns({ rows, aLabel, bLabel, aColor = '#10b981', bColor = '#3b82f6', height = 190 }) {
  if (!rows.length) return <Empty />;
  const max = niceMax(Math.max(...rows.flatMap((r) => [r.a || 0, r.b || 0]), 1));
  return (
    <div>
      <div style={{ position: 'relative', height: `${height}px`, display: 'flex', alignItems: 'flex-end', gap: '8px', borderBottom: '1px solid #cbd5e0' }}>
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <div key={t} style={{ position: 'absolute', left: 0, right: 0, top: `${(1 - t) * 100}%`, borderTop: '1px dashed #e2e8f0', pointerEvents: 'none' }}>
            <span style={{ position: 'absolute', left: 0, top: '-7px', fontSize: '9px', color: MUTED, background: 'var(--bg-card, #fff)' }}>{Math.round(max * t).toLocaleString()}</span>
          </div>
        ))}
        {rows.map((r) => (
          <div key={r.key} title={`${r.label}\n${aLabel}: ${(r.a || 0).toLocaleString()}\n${bLabel}: ${(r.b || 0).toLocaleString()}`} style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '2px', zIndex: 1 }}>
            <div style={{ width: '40%', maxWidth: '18px', height: `${((r.a || 0) / max) * 100}%`, backgroundColor: aColor, borderRadius: '3px 3px 0 0' }} />
            <div style={{ width: '40%', maxWidth: '18px', height: `${((r.b || 0) / max) * 100}%`, backgroundColor: bColor, borderRadius: '3px 3px 0 0' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '5px' }}>
        {rows.map((r) => <div key={r.key} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: '10px', color: '#4a5568' }}>{r.label}</div>)}
      </div>
      <div style={{ display: 'flex', gap: '16px', marginTop: '8px', fontSize: '11px', color: '#4a5568' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: aColor }} />{aLabel}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: bColor }} />{bLabel}</span>
      </div>
    </div>
  );
}

/** Year × month heat table for one metric. cells: { 'YYYY-MM': value } */
export function SeasonHeat({ cells, format, goodHigh = true }) {
  const keys = Object.keys(cells);
  if (!keys.length) return <Empty />;
  const years = [...new Set(keys.map((k) => k.slice(0, 4)))].sort();
  const vals = Object.values(cells);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shade = (v) => {
    const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
    const k = goodHigh ? t : 1 - t;
    return `rgba(${Math.round(226 - k * 190)}, ${Math.round(236 - k * 60)}, ${Math.round(255 - k * 130)}, ${0.35 + 0.65 * k})`;
  };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: '2px', width: '100%', fontSize: '10px', tableLayout: 'fixed' }}>
        <thead>
          <tr><th style={{ width: '38px' }} />{M.map((m) => <th key={m} style={{ fontWeight: 600, color: MUTED, padding: '2px 0' }}>{m}</th>)}</tr>
        </thead>
        <tbody>
          {years.map((y) => (
            <tr key={y}>
              <td style={{ fontWeight: 700, paddingRight: '6px' }}>{y}</td>
              {M.map((m, i) => {
                const key = `${y}-${String(i + 1).padStart(2, '0')}`;
                const v = cells[key];
                return (
                  <td key={m} title={v === undefined ? 'No data' : `${m} ${y}: ${format(v)}`} style={{ textAlign: 'center', padding: '8px 0', borderRadius: '4px', backgroundColor: v === undefined ? 'transparent' : shade(v), color: '#1a202c', fontWeight: 600, border: v === undefined ? '1px dashed #e2e8f0' : 'none' }}>
                    {v === undefined ? '' : format(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Small stat card used by both Market tabs. */
export function Stat({ label, value, sub, accent = '#3182ce', valueColor, delta }) {
  return (
    <div style={{ backgroundColor: 'var(--bg-card, #fff)', border: '1px solid var(--border-color, #e2e8f0)', borderTop: `4px solid ${accent}`, borderRadius: '8px', padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', minWidth: 0 }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: MUTED, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '26px', fontWeight: 700, color: valueColor, marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      <div style={{ fontSize: '12px', color: MUTED, marginTop: '2px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        {delta}
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

/** ▲/▼ pill. good: true=green when up, false=green when down, null=neutral. */
export function Delta({ pct, good = true, suffix = '' }) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  const up = pct >= 0;
  const positive = good === null ? null : up === good;
  const color = positive === null ? '#4a5568' : positive ? '#2f855a' : '#c53030';
  return <b style={{ color, fontSize: '12px' }}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%{suffix}</b>;
}

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(filename, columns, rows) {
  const lines = [columns.map((c) => csvCell(c.label)).join(',')];
  rows.forEach((r) => lines.push(columns.map((c) => csvCell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(',')));
  const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
