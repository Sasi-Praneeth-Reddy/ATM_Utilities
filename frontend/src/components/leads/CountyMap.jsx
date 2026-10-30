import { useMemo, useState } from 'react';
import shapes from '../../assets/county-shapes.json';

/**
 * County map of the areas we collect leads from (VA, MD, DC, WV): each collected county is filled by
 * how many listings it has; all other counties are drawn pale for context and carry no label.
 * Pure SVG, no map tiles. Shapes come from US Census county boundaries (assets/county-shapes.json,
 * simplified); the file also marks which Virginia/Maryland entries are independent cities.
 */

const norm = (s) => String(s || '').toLowerCase().replace(/[.']/g, '').replace(/\bsaint\b/g, 'st')
  .replace(/\s+county$/, '').replace(/\s+city$/, '').trim();

// feature lookup: "VA|fairfax" -> { county, city }
const INDEX = (() => {
  const m = new Map();
  shapes.f.forEach((f, i) => {
    const k = `${f.s}|${norm(f.n)}`;
    const e = m.get(k) || {};
    e[f.t] = i;
    m.set(k, e);
  });
  return m;
})();

function featureFor(state, countyName) {
  const e = INDEX.get(`${state}|${norm(countyName)}`);
  if (!e) return -1;
  const cityHint = /\bcity\b/i.test(countyName);
  const idx = cityHint ? (e.city ?? e.county) : (e.county ?? e.city);
  return idx === undefined ? -1 : idx;
}

const METRICS = {
  count: { label: 'Listings', from: [219, 234, 254], to: [23, 37, 120], fmt: (v) => Math.round(v).toLocaleString() },
  under_contract: { label: 'Under contract', from: [255, 237, 213], to: [175, 62, 8], fmt: (v) => Math.round(v).toLocaleString() },
  avgPrice: { label: 'Average price', from: [237, 233, 254], to: [76, 29, 149], fmt: (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1000)}k`) },
};
const mix = (a, b, t) => `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(',')})`;

export default function CountyMap({ stats = [], collected = [], onSelect, selected = null }) {
  const [metric, setMetric] = useState('count');
  const [hover, setHover] = useState(null);

  const { byFeature, collectedSet, vb } = useMemo(() => {
    const byFeature = new Map();
    for (const r of stats) {
      const i = featureFor(r.state, r.county);
      if (i < 0) continue;
      const cur = byFeature.get(i) || { state: r.state, county: r.county, count: 0, under_contract: 0, for_sale: 0, priceSum: 0, priceCount: 0 };
      cur.count += r.count || 0;
      cur.under_contract += r.under_contract || 0;
      cur.for_sale += r.for_sale || 0;
      if (r.avgPrice) { cur.priceSum += r.avgPrice * (r.count || 1); cur.priceCount += r.count || 1; }
      byFeature.set(i, cur);
    }
    const collectedSet = new Set(byFeature.keys());
    for (const c of collected) { const i = featureFor(c.state, c.county); if (i >= 0) collectedSet.add(i); }
    // crop the view to the counties we collect, so they fill the map
    // (a far-away outlier such as Richmond is left out of the framing so it doesn't shrink everything else)
    const ids = [...collectedSet];
    const mx = ids.map((i) => shapes.f[i].c[0]).sort((a, b) => a - b)[Math.floor(ids.length / 2)] || 0;
    const my = ids.map((i) => shapes.f[i].c[1]).sort((a, b) => a - b)[Math.floor(ids.length / 2)] || 0;
    const dist = (i) => Math.hypot(shapes.f[i].c[0] - mx, shapes.f[i].c[1] - my);
    const p75 = ids.map(dist).sort((a, b) => a - b)[Math.floor(ids.length * 0.75)] || 1;
    const core = ids.filter((i) => dist(i) <= p75 * 2.2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (core.length ? core : ids).forEach((i) => { const b = shapes.f[i].b; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); });
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = shapes.w; y1 = shapes.h; }
    const padX = (x1 - x0) * 0.06, padY = (y1 - y0) * 0.08;
    return { byFeature, collectedSet, vb: { x: x0 - padX, y: y0 - padY, w: x1 - x0 + padX * 2, h: y1 - y0 + padY * 2 } };
  }, [stats, collected]);

  const M = METRICS[metric];
  const valueOf = (d) => (!d ? 0 : metric === 'avgPrice' ? (d.priceCount ? d.priceSum / d.priceCount : 0) : d[metric] || 0);
  const values = [...byFeature.values()].map(valueOf).filter((v) => v > 0);
  const vMax = Math.max(1, ...values);
  const vMin = values.length ? Math.min(...values) : 0;
  const tOf = (v) => (metric === 'avgPrice' ? (vMax === vMin ? 1 : (v - vMin) / (vMax - vMin)) : Math.sqrt(v / vMax));
  const total = [...byFeature.values()].reduce((s, d) => s + d.count, 0);

  const hovered = hover !== null ? byFeature.get(hover) : null;
  const order = shapes.f.map((_, i) => i);
  const base = order.filter((i) => !collectedSet.has(i));
  const live = order.filter((i) => collectedSet.has(i)).sort((a, b) => (a === hover) - (b === hover));
  const fontSize = Math.min(vb.w / 52, vb.h / 34);
  const shortName = (f) => (f.n === 'District of Columbia' ? 'D.C.' : f.n.replace(' city', ''));
  const isSelected = (d) => selected && d && selected.state === d.state && norm(selected.county) === norm(d.county);

  return (
    <div className="county-map" style={{ position: 'relative' }}>
      <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} role="img" aria-label="Map of the counties we collect listings from"
        style={{ width: '100%', height: '460px', display: 'block', background: 'linear-gradient(180deg,#f4f8fc,#e9f0f8)', borderRadius: '6px', border: '1px solid #e2e8f0' }}
        preserveAspectRatio="xMidYMid meet">
        <g>
          {base.map((i) => <path key={i} d={shapes.f[i].d} fill="#e6ebf2" stroke="#fff" strokeWidth={vb.w / 900} />)}
        </g>
        <g>
          {live.map((i) => {
            const f = shapes.f[i];
            const d = byFeature.get(i);
            const v = valueOf(d);
            const fill = v > 0 ? mix(M.from, M.to, Math.min(1, Math.max(0.04, tOf(v)))) : '#dfe5ee';
            const active = hover === i || isSelected(d);
            return (
              <path key={i} d={f.d} fill={fill} className="county-shape"
                stroke={active ? '#0f172a' : '#fff'} strokeWidth={active ? vb.w / 330 : vb.w / 700} strokeLinejoin="round"
                style={{ cursor: d && onSelect ? 'pointer' : 'default' }}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onClick={d && onSelect ? () => onSelect(d.state, d.county) : undefined}>
                <title>{`${f.n}${f.t === 'city' ? ' (city)' : ' County'}, ${f.s}`}</title>
              </path>
            );
          })}
        </g>
        <g pointerEvents="none" fontFamily="Inter, -apple-system, Segoe UI, sans-serif">
          {live.map((i) => {
            const f = shapes.f[i];
            const d = byFeature.get(i);
            const w = f.b[2] - f.b[0];
            const v = valueOf(d);
            // a label is drawn only when it fits inside its county; otherwise it appears on hover
            if (w * 1.15 < shortName(f).length * fontSize * 0.55 && hover !== i) return null;
            const dark = v > 0 && tOf(v) > 0.5;
            return (
              <text key={i} x={f.c[0]} y={f.c[1]} textAnchor="middle" fontSize={fontSize} fontWeight="700"
                fill={dark ? '#fff' : '#1a202c'} stroke={dark ? 'rgba(15,23,42,.35)' : 'rgba(255,255,255,.85)'} strokeWidth={fontSize / 7} paintOrder="stroke">
                {shortName(f)}
                {d && <tspan x={f.c[0]} dy={fontSize * 1.05} fontWeight="600" fontSize={fontSize * 0.9}>{M.fmt(v)}</tspan>}
              </text>
            );
          })}
        </g>
      </svg>

      {/* Info panel (top-left), like a results card */}
      <div style={{ position: 'absolute', left: '12px', bottom: '58px', width: '210px', background: 'rgba(255,255,255,.96)', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 14px rgba(16,28,56,.12)', padding: '10px 12px', fontSize: '12px' }}>
        {hovered ? (
          <>
            <div style={{ fontWeight: 800, fontSize: '14px', color: '#1a202c' }}>{hovered.county.replace(/ County$/, '')}, {hovered.state}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 10px', marginTop: '6px', color: '#4a5568' }}>
              <span>Listings</span><b style={{ color: '#2b6cb0' }}>{hovered.count.toLocaleString()}</b>
              <span>Under contract</span><b style={{ color: '#c2410c' }}>{hovered.under_contract.toLocaleString()}</b>
              <span>Average price</span><b style={{ color: '#5b21b6' }}>{hovered.priceCount ? METRICS.avgPrice.fmt(hovered.priceSum / hovered.priceCount) : '-'}</b>
              <span>Share of all</span><b>{total ? `${((hovered.count / total) * 100).toFixed(1)}%` : '-'}</b>
            </div>
            {onSelect && <div style={{ marginTop: '6px', color: '#718096', fontSize: '11px' }}>Click to see these listings</div>}
          </>
        ) : (
          <>
            <div style={{ fontWeight: 800, fontSize: '13px', color: '#1a202c' }}>Counties we collect</div>
            <div style={{ color: '#4a5568', marginTop: '4px' }}><b style={{ color: '#2b6cb0' }}>{total.toLocaleString()}</b> listings across {collectedSet.size} counties</div>
            <div style={{ color: '#718096', fontSize: '11px', marginTop: '4px' }}>Hover a county for details. Grey areas are not collected.</div>
          </>
        )}
      </div>

      {/* Metric switch + legend (bottom) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
        <div style={{ display: 'flex', backgroundColor: '#edf2f7', padding: '2px', borderRadius: '6px' }}>
          {Object.entries(METRICS).map(([id, m]) => (
            <button key={id} type="button" onClick={() => setMetric(id)}
              style={{ padding: '4px 10px', borderRadius: '4px', border: 'none', fontSize: '11px', fontWeight: 700, cursor: 'pointer', backgroundColor: metric === id ? '#2b6cb0' : 'transparent', color: metric === id ? '#fff' : '#4a5568' }}>
              {m.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#718096' }}>
          <span>{metric === 'avgPrice' ? M.fmt(vMin) : '0'}</span>
          <span style={{ width: '140px', height: '10px', borderRadius: '5px', background: `linear-gradient(90deg, ${mix(M.from, M.to, 0)}, ${mix(M.from, M.to, 0.5)}, ${mix(M.from, M.to, 1)})`, border: '1px solid #e2e8f0' }} />
          <span>{M.fmt(vMax)}</span>
        </div>
      </div>
    </div>
  );
}
