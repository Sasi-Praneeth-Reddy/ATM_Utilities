import { useEffect, useMemo, useRef, useState } from 'react';
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
  count: { label: 'Listings', from: [204, 251, 241], to: [4, 94, 84], fmt: (v) => Math.round(v).toLocaleString() },
  under_contract: { label: 'Under contract', from: [254, 243, 199], to: [180, 83, 9], fmt: (v) => Math.round(v).toLocaleString() },
  avgPrice: { label: 'Average price', from: [237, 233, 254], to: [76, 29, 149], fmt: (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1000)}k`) },
};
const mix = (a, b, t) => `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(',')})`;

export default function CountyMap({ stats = [], collected = [], onSelect, selected = null, focusState = 'all', filtered = false }) {
  const [metric, setMetric] = useState('count');
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const movedRef = useRef(false);
  // zoom 1 = the framed view; center is in map units (null = centre of the frame)
  const [view, setView] = useState({ zoom: 1, cx: null, cy: null });

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
    const focusIds = focusState && focusState !== 'all' ? [...collectedSet].filter((i) => shapes.f[i].s === focusState) : [];
    const ids = focusIds.length ? focusIds : [...collectedSet];
    const mx = ids.map((i) => shapes.f[i].c[0]).sort((a, b) => a - b)[Math.floor(ids.length / 2)] || 0;
    const my = ids.map((i) => shapes.f[i].c[1]).sort((a, b) => a - b)[Math.floor(ids.length / 2)] || 0;
    const dist = (i) => Math.hypot(shapes.f[i].c[0] - mx, shapes.f[i].c[1] - my);
    const p75 = ids.map(dist).sort((a, b) => a - b)[Math.floor(ids.length * 0.75)] || 1;
    const core = focusIds.length ? ids : ids.filter((i) => dist(i) <= p75 * 2.2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (core.length ? core : ids).forEach((i) => { const b = shapes.f[i].b; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); });
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = shapes.w; y1 = shapes.h; }
    const padX = (x1 - x0) * 0.06, padY = (y1 - y0) * 0.08;
    return { byFeature, collectedSet, vb: { x: x0 - padX, y: y0 - padY, w: x1 - x0 + padX * 2, h: y1 - y0 + padY * 2 } };
  }, [stats, collected, focusState]);

  // a new frame (state filter changed) resets the zoom
  useEffect(() => { setView({ zoom: 1, cx: null, cy: null }); }, [focusState]);

  const cx0 = view.cx ?? vb.x + vb.w / 2;
  const cy0 = view.cy ?? vb.y + vb.h / 2;
  const cur = { w: vb.w / view.zoom, h: vb.h / view.zoom };
  cur.x = cx0 - cur.w / 2; cur.y = cy0 - cur.h / 2;

  function zoomAt(factor, ux, uy) {
    setView((v) => {
      const z = Math.min(10, Math.max(1, v.zoom * factor));
      const f = z / v.zoom;
      const ccx = v.cx ?? vb.x + vb.w / 2, ccy = v.cy ?? vb.y + vb.h / 2;
      const px = ux ?? ccx, py = uy ?? ccy;
      return z === 1 ? { zoom: 1, cx: null, cy: null } : { zoom: z, cx: px - (px - ccx) / f, cy: py - (py - ccy) / f };
    });
  }
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const ctm = el.getScreenCTM();
      if (!ctm) return;
      const pt = el.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const u = pt.matrixTransform(ctm.inverse());
      zoomRef.current(e.deltaY < 0 ? 1.25 : 0.8, u.x, u.y);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, cx: cx0, cy: cy0 };
    movedRef.current = false;
  }
  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!movedRef.current && Math.hypot(dx, dy) < 5) return;
    movedRef.current = true;
    const ctm = svgRef.current.getScreenCTM();
    const k = ctm ? ctm.a : 1;
    setView((v) => ({ ...v, cx: d.cx - dx / k, cy: d.cy - dy / k }));
  }
  function endDrag() { dragRef.current = null; setTimeout(() => { movedRef.current = false; }, 0); }

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
  const fontSize = Math.min(cur.w / 52, cur.h / 34);
  const shortName = (f) => (f.n === 'District of Columbia' ? 'D.C.' : f.n.replace(' city', ''));
  const isSelected = (d) => selected && d && selected.state === d.state && norm(selected.county) === norm(d.county);

  return (
    <div className="county-map" style={{ position: 'relative' }}>
      <svg ref={svgRef} viewBox={`${cur.x} ${cur.y} ${cur.w} ${cur.h}`} role="img" aria-label="Map of the counties we collect listings from"
        style={{ width: '100%', height: '460px', display: 'block', background: 'linear-gradient(180deg,#f6f8f7,#e8eeec)', borderRadius: '6px', border: '1px solid #e2e8f0', cursor: view.zoom > 1 ? 'grab' : 'default', touchAction: 'none', userSelect: 'none' }}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerLeave={endDrag}>
        <g>
          {base.map((i) => <path key={i} d={shapes.f[i].d} fill="#e6ebf2" stroke="#fff" strokeWidth={cur.w / 900} />)}
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
                stroke={active ? '#0f172a' : '#fff'} strokeWidth={active ? cur.w / 330 : cur.w / 700} strokeLinejoin="round"
                style={{ cursor: d && onSelect ? 'pointer' : 'inherit' }}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onClick={d && onSelect ? () => { if (!movedRef.current) onSelect(d.state, d.county); } : undefined}>
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

      {/* Zoom controls */}
      <div style={{ position: 'absolute', right: '12px', top: '12px', display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,.96)', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 14px rgba(16,28,56,.12)', overflow: 'hidden' }}>
        {[['+', 'Zoom in', () => zoomAt(1.5)], ['-', 'Zoom out', () => zoomAt(1 / 1.5)], ['Reset', 'Reset the view', () => setView({ zoom: 1, cx: null, cy: null })]].map(([label, title, fn]) => (
          <button key={label} type="button" title={title} aria-label={title} onClick={fn}
            style={{ width: label === 'Reset' ? 'auto' : '34px', height: '32px', padding: label === 'Reset' ? '0 8px' : 0, border: 'none', borderBottom: '1px solid #edf2f7', background: 'transparent', fontSize: label === 'Reset' ? '10px' : '18px', fontWeight: 700, color: '#2d3748', cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Info panel (bottom-left), like a results card */}
      <div style={{ position: 'absolute', left: '12px', bottom: '58px', width: '210px', background: 'rgba(255,255,255,.96)', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 14px rgba(16,28,56,.12)', padding: '10px 12px', fontSize: '12px' }}>
        {hovered ? (
          <>
            <div style={{ fontWeight: 800, fontSize: '14px', color: '#1a202c' }}>{hovered.county.replace(/ County$/, '')}, {hovered.state}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 10px', marginTop: '6px', color: '#4a5568' }}>
              <span>Listings</span><b style={{ color: '#0f766e' }}>{hovered.count.toLocaleString()}</b>
              <span>Under contract</span><b style={{ color: '#c2410c' }}>{hovered.under_contract.toLocaleString()}</b>
              <span>Average price</span><b style={{ color: '#5b21b6' }}>{hovered.priceCount ? METRICS.avgPrice.fmt(hovered.priceSum / hovered.priceCount) : '-'}</b>
              <span>Share of all</span><b>{total ? `${((hovered.count / total) * 100).toFixed(1)}%` : '-'}</b>
            </div>
            {onSelect && <div style={{ marginTop: '6px', color: '#718096', fontSize: '11px' }}>Click to see these listings</div>}
          </>
        ) : (
          <>
            <div style={{ fontWeight: 800, fontSize: '13px', color: '#1a202c' }}>Counties we collect</div>
            <div style={{ color: '#4a5568', marginTop: '4px' }}><b style={{ color: '#0f766e' }}>{total.toLocaleString()}</b> listings across {collectedSet.size} counties</div>
            <div style={{ color: '#718096', fontSize: '11px', marginTop: '4px' }}>Hover a county for details. Scroll or use + / - to zoom, drag to move. Grey areas are not collected.</div>
            {filtered && <div style={{ color: '#0f766e', fontSize: '11px', marginTop: '4px', fontWeight: 600 }}>Showing only listings that match your filters.</div>}
          </>
        )}
      </div>

      {/* Metric switch + legend (bottom) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
        <div style={{ display: 'flex', backgroundColor: '#edf2f7', padding: '2px', borderRadius: '6px' }}>
          {Object.entries(METRICS).map(([id, m]) => (
            <button key={id} type="button" onClick={() => setMetric(id)}
              style={{ padding: '4px 10px', borderRadius: '4px', border: 'none', fontSize: '11px', fontWeight: 700, cursor: 'pointer', backgroundColor: metric === id ? '#0f766e' : 'transparent', color: metric === id ? '#fff' : '#4a5568' }}>
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
