// Visualizations for the Leads "Market Visualizations" tab. Plain HTML/SVG (no chart library) so they
// stay light and follow the app's colours.
import { useState } from 'react';

// ---- Listing-volume charts (Market Visualizations tab) ----
export const STATUS_STACK = [
  { key: 'for_sale', label: 'Active for sale', color: '#10b981' },
  { key: 'under_contract', label: 'Under contract', color: '#f97316' },
  { key: 'pending', label: 'Pending / contingent', color: '#3b82f6' },
  { key: 'closed', label: 'Closed / sold', color: '#94a3b8' },
];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(key, withYear = true) {
  const [y, m] = String(key).split('-');
  const name = MONTH_NAMES[Number(m) - 1] || key;
  return withYear ? `${name} ${y}` : name;
}

export function weekLabel(mondayKey) {
  const [, m, d] = String(mondayKey).split('-');
  return `${MONTH_NAMES[Number(m) - 1] || ''} ${Number(d)}`;
}

function niceMax(v) {
  if (v <= 10) return 10;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Stacked column chart. `rows`: [{ key, label, sub?, total, for_sale, ... }]; click a column to
    drill in (onSelect(key)). Plain HTML/CSS so it stays responsive without a chart library. */
export function StackedColumns({ rows, selectedKey, onSelect, height = 200 }) {
  const max = niceMax(Math.max(...rows.map((r) => r.total), 1));
  const ticks = [1, 0.75, 0.5, 0.25, 0];
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <div style={{ position: 'relative', width: '38px', height: `${height}px`, flex: 'none' }}>
        {ticks.map((t) => (
          <span key={t} style={{ position: 'absolute', right: 0, top: `${(1 - t) * 100}%`, transform: 'translateY(-50%)', fontSize: '10px', color: '#718096' }}>
            {Math.round(max * t).toLocaleString()}
          </span>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ position: 'relative', height: `${height}px`, display: 'flex', alignItems: 'flex-end', gap: '6px', borderBottom: '1px solid #cbd5e0' }}>
          {ticks.slice(0, 4).map((t) => (
            <div key={t} style={{ position: 'absolute', left: 0, right: 0, top: `${(1 - t) * 100}%`, borderTop: '1px dashed #e2e8f0', pointerEvents: 'none' }} />
          ))}
          {rows.map((r) => {
            const known = STATUS_STACK.reduce((s, x) => s + (r[x.key] || 0), 0);
            const segs = STATUS_STACK.map((x) => ({ ...x, n: r[x.key] || 0 }));
            if (r.total > known) segs.push({ key: 'other', label: 'Other', color: '#cbd5e0', n: r.total - known });
            const selected = selectedKey === r.key;
            const tip = `${r.label}${r.sub ? ' ' + r.sub : ''}: ${r.total.toLocaleString()} listings\n` + segs.filter((s) => s.n).map((s) => `${s.label}: ${s.n.toLocaleString()}`).join('\n');
            return (
              <button
                key={r.key}
                type="button"
                title={tip}
                onClick={() => onSelect && onSelect(r.key)}
                style={{
                  position: 'relative', flex: 1, minWidth: 0, height: '100%', padding: 0, border: 'none', background: 'none',
                  display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', cursor: onSelect ? 'pointer' : 'default',
                  opacity: selectedKey && !selected ? 0.45 : 1,
                }}
              >
                <span style={{ fontSize: '10px', fontWeight: 700, color: '#2d3748', textAlign: 'center', marginBottom: '2px', whiteSpace: 'nowrap' }}>
                  {r.total.toLocaleString()}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column-reverse', height: `${(r.total / max) * 100}%`, minHeight: '2px', borderRadius: '4px 4px 0 0', overflow: 'hidden', outline: selected ? '2px solid #2b6cb0' : 'none' }}>
                  {segs.map((s) => (s.n ? <div key={s.key} style={{ height: `${(s.n / r.total) * 100}%`, backgroundColor: s.color }} /> : null))}
                </div>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
          {rows.map((r) => (
            <div key={r.key} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: '11px', color: '#4a5568', lineHeight: 1.2 }}>
              <div style={{ fontWeight: selectedKey === r.key ? 800 : 600 }}>{r.label}</div>
              {r.sub && <div style={{ fontSize: '10px', color: '#718096' }}>{r.sub}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function StatusLegend() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', margin: '10px 0 0 46px', fontSize: '11px', color: '#4a5568' }}>
      {STATUS_STACK.map((s) => (
        <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: s.color }} />{s.label}
        </span>
      ))}
    </div>
  );
}

const CARD = { backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', padding: '20px', minWidth: 0 };
const H3 = { margin: '0 0 4px 0', fontSize: '16px', fontWeight: 700 };
const SUB = { margin: '0 0 14px 0', fontSize: '12px', color: '#718096' };

export function Card({ title, subtitle, children, style }) {
  return (
    <div style={{ ...CARD, ...style }}>
      <h3 style={H3}>{title}</h3>
      {subtitle && <p style={SUB}>{subtitle}</p>}
      {children}
    </div>
  );
}

const money = (v) => (v >= 1000000 ? `$${(v / 1000000).toFixed(2)}M` : `$${Math.round(v / 1000)}k`);

/** Donut: share of listings by current status. */
export function StatusDonut({ counts }) {
  const parts = [
    ...STATUS_STACK.map((s) => ({ ...s, n: counts?.[s.key] || 0 })),
    { key: 'coming_soon', label: 'Coming soon', color: '#a78bfa', n: counts?.coming_soon || 0 },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return <div style={{ fontSize: '12px', color: '#718096' }}>No status data yet.</div>;
  const R = 62, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' }}>
      <svg width="180" height="180" viewBox="0 0 180 180" role="img" aria-label="Listings by status">
        <g transform="rotate(-90 90 90)">
          {parts.map((p) => {
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
        <text x="90" y="86" textAnchor="middle" fontSize="22" fontWeight="800" fill="currentColor">{total.toLocaleString()}</text>
        <text x="90" y="104" textAnchor="middle" fontSize="11" fill="#718096">listings</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', flex: 1, minWidth: '180px' }}>
        {parts.map((p) => (
          <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '11px', height: '11px', borderRadius: '3px', backgroundColor: p.color, flex: 'none' }} />
            <span style={{ flex: 1 }}>{p.label}</span>
            <strong>{p.n.toLocaleString()}</strong>
            <span style={{ width: '38px', textAlign: 'right', color: '#718096' }}>{Math.round((p.n / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Histogram of list prices; the band holding the median is highlighted. */
export function PriceHistogram({ bins, median }) {
  const max = Math.max(...bins.map((b) => b.count), 1);
  const medianBin = bins.findIndex((b) => median >= b.min && (b.max === null || median < b.max));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '170px', borderBottom: '1px solid #cbd5e0' }}>
        {bins.map((b, i) => (
          <div key={b.label} title={`${b.label}: ${b.count.toLocaleString()} listings`}
            style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, textAlign: 'center', color: '#2d3748' }}>{b.count ? b.count.toLocaleString() : ''}</span>
            <div style={{ height: `${(b.count / max) * 88}%`, minHeight: b.count ? '2px' : 0, backgroundColor: i === medianBin ? '#f97316' : '#4299e1', borderRadius: '3px 3px 0 0' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
        {bins.map((b) => (
          <div key={b.label} style={{ flex: 1, minWidth: 0, fontSize: '10px', color: '#4a5568', textAlign: 'center', lineHeight: 1.2, overflowWrap: 'anywhere' }}>{b.label}</div>
        ))}
      </div>
      <div style={{ marginTop: '10px', fontSize: '12px', color: '#4a5568' }}>
        <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#f97316', marginRight: '6px' }} />
        Band containing the median price ({money(median)})
      </div>
    </div>
  );
}

/** Calendar heat map: one square per day, weeks as columns, darker = more homes listed that day. */
export function ActivityHeatmap({ daily, weeks = 22 }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + (7 - ((end.getDay() + 6) % 7) - 1)); // Sunday of this week
  const start = new Date(end);
  start.setDate(start.getDate() - weeks * 7 + 1);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cols = [];
  let max = 1;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      const key = iso(day);
      const n = daily[key] || 0;
      if (n > max) max = n;
      col.push({ key, n, future: day > today });
    }
    cols.push(col);
  }
  const shade = (n) => {
    if (!n) return '#edf2f7';
    const t = n / max;
    return t > 0.75 ? '#1e3a8a' : t > 0.5 ? '#2b6cb0' : t > 0.25 ? '#4299e1' : '#90cdf4';
  };
  const dayNames = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: '4px', minWidth: `${weeks * 20 + 40}px` }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', paddingTop: '18px', width: '30px', flex: 'none' }}>
          {dayNames.map((n, i) => (<div key={i} style={{ height: '15px', fontSize: '10px', color: '#718096', lineHeight: '15px' }}>{n}</div>))}
        </div>
        {cols.map((col, ci) => {
          const first = col[0].key;
          const showMonth = ci === 0 || first.slice(5, 7) !== cols[ci - 1][0].key.slice(5, 7);
          return (
            <div key={first} style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: '0 1 38px', minWidth: 0 }}>
              <div style={{ height: '15px', fontSize: '10px', color: '#4a5568', fontWeight: 600, whiteSpace: 'nowrap' }}>
                {showMonth ? MONTH_NAMES[Number(first.slice(5, 7)) - 1] : ''}
              </div>
              {col.map((c) => (
                <div key={c.key} title={c.future ? '' : `${c.key}: ${c.n.toLocaleString()} listings`}
                  style={{ height: '15px', borderRadius: '3px', backgroundColor: c.future ? 'transparent' : shade(c.n), border: c.future ? '1px dashed #e2e8f0' : 'none' }} />
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', fontSize: '11px', color: '#718096', justifyContent: 'flex-end' }}>
        Fewer
        {['#edf2f7', '#90cdf4', '#4299e1', '#2b6cb0', '#1e3a8a'].map((c) => (<span key={c} style={{ width: '14px', height: '14px', borderRadius: '3px', backgroundColor: c }} />))}
        More (busiest day: {max.toLocaleString()})
      </div>
    </div>
  );
}

/** Bubble chart: each county placed by listing volume (x) and average price (y); bubble size = volume. */
export function CountyBubbles({ counties }) {
  // Side-by-side ranked bars instead of overlapping bubbles: every county gets its own row, so crowded
  // counties (same size, similar price) stay readable. Sorted by listing volume.
  const rows = counties.filter((c) => c.avgPrice > 0 && c.count > 0).slice(0, 14).sort((a, b) => b.count - a.count);
  const [hover, setHover] = useState(null);
  if (rows.length < 2) return <div style={{ fontSize: '12px', color: '#718096' }}>Not enough county data yet.</div>;
  const maxCount = Math.max(...rows.map((r) => r.count));
  const maxPrice = Math.max(...rows.map((r) => r.avgPrice));
  const medPrice = [...rows].map((r) => r.avgPrice).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const head = { fontSize: '11px', fontWeight: 700, color: 'var(--muted, #718096)', textTransform: 'uppercase', letterSpacing: '.04em' };
  return (
    <div role="table" aria-label="Counties by listing volume and average price" style={{ display: 'grid', gridTemplateColumns: 'minmax(92px, 130px) minmax(0, 1fr) minmax(0, 1fr)', columnGap: '14px', rowGap: '6px', alignItems: 'center' }}>
      <div style={head}>County</div>
      <div style={head}>Listings</div>
      <div style={head}>Average price</div>
      {rows.map((r) => {
        const dim = hover && hover !== r.county;
        const pricey = r.avgPrice > medPrice;
        return (
          <div key={r.county} role="row" onMouseEnter={() => setHover(r.county)} onMouseLeave={() => setHover(null)}
            title={`${r.county}: ${r.count.toLocaleString()} listings, avg ${money(r.avgPrice)}`}
            style={{ display: 'contents' }}>
            <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--heading, #1a202c)', opacity: dim ? 0.4 : 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.county.replace(' County', '')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: dim ? 0.4 : 1 }}>
              <div style={{ height: '14px', width: `${Math.max(2, (r.count / maxCount) * 100)}%`, maxWidth: 'calc(100% - 52px)', background: '#3182ce', borderRadius: '4px' }} />
              <span style={{ fontSize: '12px', color: 'var(--text, #2d3748)', fontVariantNumeric: 'tabular-nums' }}>{r.count.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: dim ? 0.4 : 1 }}>
              <div style={{ height: '14px', width: `${Math.max(2, (r.avgPrice / maxPrice) * 100)}%`, maxWidth: 'calc(100% - 56px)', background: pricey ? '#f97316' : '#f6ad79', borderRadius: '4px' }} />
              <span style={{ fontSize: '12px', color: 'var(--text, #2d3748)', fontVariantNumeric: 'tabular-nums' }}>{money(r.avgPrice)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Monthly stacked columns (click a month to filter listings to it). */
export function MonthlyPanel({ monthly, selectedMonth, onSelectMonth }) {
  if (!monthly.length) return null;
  const peak = monthly.reduce((a, b) => (b.total > a.total ? b : a), monthly[0]);
  const rows = monthly.map((m, i) => ({
    ...m, key: m.month, label: monthLabel(m.month, false), sub: i === 0 || m.month.endsWith('-01') ? m.month.slice(0, 4) : '',
  }));
  return (
    <Card title="📅 Listings by month" subtitle={`Homes by the month they were listed, split by status. Busiest: ${monthLabel(peak.month)} (${peak.total.toLocaleString()}). Click a month to filter the listings.`}>
      <StackedColumns rows={rows} selectedKey={selectedMonth !== 'all' ? selectedMonth : null} onSelect={onSelectMonth} height={210} />
      <StatusLegend />
    </Card>
  );
}
