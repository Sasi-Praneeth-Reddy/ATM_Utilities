import { useState, useEffect, useMemo, useRef } from 'react';
import { apiCall } from '../../api';
import { Card, Empty, HBars, RangeBars, Histogram, Donut, RankList, Stat, Delta, money, downloadCsv } from './MarketCharts';

// Brand colours (kept from the original dashboard)
const BRAND_COLORS = {
  'Public Storage': '#f97316',
  'Extra Space Storage': '#10b981',
  'Extra Space': '#10b981',
  CubeSmart: '#ef4444',
  'Self Storage Plus': '#3b82f6',
  'U-Haul': '#8b5cf6',
  StorageMart: '#0ea5e9',
  Independent: '#64748b',
};

function getBrandColor(brand = '') {
  for (const [key, color] of Object.entries(BRAND_COLORS)) {
    if (brand.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return '#64748b';
}

const UNIT_SIZES = ['5x5', '5x10', '10x10', '10x15', '10x20', '10x25'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const LABEL = { fontSize: '11px', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.02em' };
const INPUT = {
  padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e0', fontSize: '12px',
  backgroundColor: 'var(--bg-card, #ffffff)', color: 'var(--text-main, #2d3748)', boxSizing: 'border-box',
};

/** Admin-only button: starts the storage-price scraper (GitHub Actions) and shows its progress. */
function UpdatePricesButton({ backendUrl }) {
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const running = run && run.status !== 'completed';

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await apiCall(backendUrl, 'GET', '/api/storage/scrape/status');
        if (active) setRun(res.run || null);
      } catch (e) { /* status is optional - the button still works */ }
    };
    load();
    if (!running) return () => { active = false; };
    const t = setInterval(load, 20000);
    return () => { active = false; clearInterval(t); };
  }, [backendUrl, running]);

  async function start() {
    setBusy(true); setMsg('');
    try {
      await apiCall(backendUrl, 'POST', '/api/storage/scrape/run', {});
      setRun({ status: 'queued', createdAt: new Date().toISOString() });
      setMsg('Started - this takes about 10 minutes.');
    } catch (e) {
      setMsg(e.message.replace(/^Backend returned \d+ — /, ''));
    } finally { setBusy(false); }
  }

  const done = run && run.status === 'completed';
  const ok = done && run.conclusion === 'success';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <button onClick={start} disabled={busy || running} style={{
        padding: '7px 14px', borderRadius: '6px', border: '1px solid #2b6cb0', fontSize: '12px', fontWeight: 700,
        cursor: busy || running ? 'default' : 'pointer', backgroundColor: busy || running ? '#e2e8f0' : '#3182ce', color: busy || running ? '#4a5568' : '#fff',
      }}>{running ? '⏳ Updating prices…' : '🔄 Update prices'}</button>
      <span style={{ fontSize: '12px', color: '#718096' }}>
        {msg || (running && 'Scraping competitor prices - about 10 minutes.')}
        {!msg && !running && done && (ok
          ? <>Last update {new Date(run.updatedAt).toLocaleString()} ✓ <a href="#" onClick={(e) => { e.preventDefault(); window.location.reload(); }}>Reload data</a></>
          : <>Last run {run.conclusion || 'ended'} - <a href={run.url} target="_blank" rel="noreferrer">view log</a></>)}
      </span>
    </div>
  );
}

export default function StorageTab({ backendUrl, role }) {
  const [unitSize, setUnitSize] = useState('10x10');
  const [selectedBrands, setSelectedBrands] = useState([]); // empty = all brands
  const [city, setCity] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [minRate, setMinRate] = useState('');
  const [maxRate, setMaxRate] = useState('');
  const [onlyPriced, setOnlyPriced] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState('dashboard'); // 'dashboard' | 'table'
  const [mapColor, setMapColor] = useState('brand'); // 'brand' | 'price'
  const [sort, setSort] = useState({ key: 'web', dir: 'asc' });
  const [visible, setVisible] = useState(100);

  const [kpis, setKpis] = useState(null);
  const [pricing, setPricing] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Map state
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersLayerRef = useRef(null);
  const [leafletReady, setLeafletReady] = useState(Boolean(window.L));

  useEffect(() => {
    if (window.L) { setLeafletReady(true); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => setLeafletReady(true);
    document.head.appendChild(script);
  }, []);

  // Facilities + KPIs load once
  useEffect(() => {
    let active = true;
    (async () => {
      const [kpiRes, facRes] = await Promise.allSettled([
        apiCall(backendUrl, 'GET', '/api/storage/kpis'),
        apiCall(backendUrl, 'GET', '/api/storage/facilities'),
      ]);
      if (!active) return;
      if (kpiRes.status === 'fulfilled' && kpiRes.value) setKpis(kpiRes.value);
      if (facRes.status === 'fulfilled' && Array.isArray(facRes.value)) setFacilities(facRes.value);
      else setError(`Storage data notice: ${facRes.reason?.message || 'could not load facilities'}`);
    })();
    return () => { active = false; };
  }, [backendUrl]);

  // Pricing reloads when the unit size changes
  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const res = await apiCall(backendUrl, 'GET', `/api/storage/pricing/latest?unitSize=${encodeURIComponent(unitSize)}`);
        if (active && Array.isArray(res)) setPricing(res);
      } catch (err) {
        if (active) setError(`Storage data notice: ${err.message}`);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [backendUrl, unitSize]);

  // Facility + its cheapest current rate for the selected unit size
  const allRows = useMemo(() => {
    const rateBy = new Map(pricing.map((p) => [String(p.facilityId), p]));
    return facilities.map((f) => {
      const p = rateBy.get(String(f.id));
      const web = p && p.webRate ? p.webRate : null;
      const street = p && p.streetRate ? p.streetRate : null;
      return {
        ...f,
        brand: f.brand || 'Independent',
        web,
        street,
        discountPct: web && street && street > web ? Math.round(((street - web) / street) * 100) : null,
        availability: p ? p.availability || 'Available' : '',
      };
    });
  }, [facilities, pricing]);

  const brandOptions = useMemo(() => [...new Set(allRows.map((r) => r.brand))].sort(), [allRows]);
  const cityOptions = useMemo(() => [...new Set(allRows.map((r) => r.city).filter(Boolean))].sort(), [allRows]);
  const stateOptions = useMemo(() => [...new Set(allRows.map((r) => r.state).filter(Boolean))].sort(), [allRows]);

  const filtersActive = selectedBrands.length > 0 || city !== 'all' || stateFilter !== 'all' || minRate !== '' || maxRate !== '' || onlyPriced || searchQuery.trim() !== '';
  const clearFilters = () => {
    setSelectedBrands([]); setCity('all'); setStateFilter('all'); setMinRate(''); setMaxRate(''); setOnlyPriced(false); setSearchQuery('');
  };
  const toggleBrand = (b) => setSelectedBrands((cur) => (cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b]));

  const rows = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const lo = minRate === '' ? null : Number(minRate);
    const hi = maxRate === '' ? null : Number(maxRate);
    return allRows.filter((r) => {
      if (selectedBrands.length && !selectedBrands.includes(r.brand)) return false;
      if (city !== 'all' && r.city !== city) return false;
      if (stateFilter !== 'all' && r.state !== stateFilter) return false;
      if ((onlyPriced || lo !== null || hi !== null) && !r.web) return false;
      if (lo !== null && r.web < lo) return false;
      if (hi !== null && r.web > hi) return false;
      if (q) {
        const hit = [r.name, r.city, r.zipCode, r.address, r.brand].some((v) => v && String(v).toLowerCase().includes(q));
        if (!hit) return false;
      }
      return true;
    });
  }, [allRows, selectedBrands, city, stateFilter, minRate, maxRate, onlyPriced, searchQuery]);

  useEffect(() => { setVisible(100); }, [rows, sort]);

  const priced = useMemo(() => rows.filter((r) => r.web), [rows]);
  const marketAvg = useMemo(() => avg(allRows.filter((r) => r.web).map((r) => r.web)), [allRows]);

  const stats = useMemo(() => {
    const rates = priced.map((r) => r.web);
    const sorted = [...priced].sort((a, b) => a.web - b.web);
    const discounts = priced.filter((r) => r.discountPct !== null).map((r) => r.discountPct);
    return {
      avg: avg(rates),
      median: median(rates),
      cheapest: sorted[0] || null,
      priciest: sorted[sorted.length - 1] || null,
      avgDiscount: discounts.length ? avg(discounts) : null,
    };
  }, [priced]);

  const byBrand = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      const e = m.get(r.brand) || { brand: r.brand, facilities: 0, rates: [], discounts: [] };
      e.facilities += 1;
      if (r.web) e.rates.push(r.web);
      if (r.discountPct !== null) e.discounts.push(r.discountPct);
      m.set(r.brand, e);
    });
    return [...m.values()].map((e) => ({
      ...e,
      color: getBrandColor(e.brand),
      min: e.rates.length ? Math.min(...e.rates) : 0,
      max: e.rates.length ? Math.max(...e.rates) : 0,
      avg: avg(e.rates),
      avgDiscount: e.discounts.length ? avg(e.discounts) : null,
    })).sort((a, b) => b.facilities - a.facilities);
  }, [rows]);

  const byCity = useMemo(() => {
    const m = new Map();
    priced.forEach((r) => {
      if (!r.city) return;
      const e = m.get(r.city) || { city: r.city, rates: [] };
      e.rates.push(r.web);
      m.set(r.city, e);
    });
    return [...m.values()].filter((e) => e.rates.length >= 2).map((e) => ({ city: e.city, avg: avg(e.rates), count: e.rates.length }))
      .sort((a, b) => b.count - a.count).slice(0, 10).sort((a, b) => b.avg - a.avg);
  }, [priced]);

  const cheapest = useMemo(() => [...priced].sort((a, b) => a.web - b.web).slice(0, 8), [priced]);
  const priciest = useMemo(() => [...priced].sort((a, b) => b.web - a.web).slice(0, 8), [priced]);

  const sortedRows = useMemo(() => {
    const get = {
      name: (r) => (r.name || '').toLowerCase(), brand: (r) => r.brand.toLowerCase(), city: (r) => (r.city || '').toLowerCase(),
      web: (r) => r.web, street: (r) => r.street, discount: (r) => r.discountPct,
    }[sort.key];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1; // blanks last
      if (y === null || y === undefined) return -1;
      return x < y ? -dir : x > y ? dir : 0;
    });
  }, [rows, sort]);

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'brand' || key === 'city' || key === 'web' || key === 'street' ? 'asc' : 'desc' }));

  // ---- Map ----
  useEffect(() => {
    if (!leafletReady || !mapContainerRef.current || viewMode !== 'dashboard') return undefined;

    if (mapInstanceRef.current && mapInstanceRef.current.getContainer() !== mapContainerRef.current) {
      try { mapInstanceRef.current.remove(); } catch (e) { /* ignore */ }
      mapInstanceRef.current = null;
    }
    if (!mapInstanceRef.current) {
      if (mapContainerRef.current._leaflet_id) delete mapContainerRef.current._leaflet_id;
      const map = window.L.map(mapContainerRef.current).setView([38.9072, -77.2653], 10);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors', maxZoom: 18,
      }).addTo(map);
      markersLayerRef.current = window.L.layerGroup().addTo(map);
      mapInstanceRef.current = map;
    }

    const markers = markersLayerRef.current;
    if (markers) {
      markers.clearLayers();
      const rates = priced.map((r) => r.web).sort((a, b) => a - b);
      const t1 = rates[Math.floor(rates.length / 3)] || 0;
      const t2 = rates[Math.floor((rates.length * 2) / 3)] || 0;
      const pts = [];
      rows.forEach((fac) => {
        const lat = Number(fac.lat);
        const lon = Number(fac.lon);
        if (!lat || !lon) return;
        pts.push([lat, lon]);
        const brandColor = getBrandColor(fac.brand);
        const color = mapColor === 'price' ? (!fac.web ? '#a0aec0' : fac.web <= t1 ? '#10b981' : fac.web <= t2 ? '#f59e0b' : '#ef4444') : brandColor;
        const rateText = fac.web ? `$${fac.web}/mo` : 'Call for rate';
        const popupHtml = `
          <div style="font-family: sans-serif; font-size: 12px; line-height: 1.4;">
            <div style="font-weight: bold; font-size: 13px; color: #1a202c; margin-bottom: 2px;">${esc(fac.name || 'Self-Storage')}</div>
            <div style="display: inline-block; padding: 2px 6px; background-color: ${brandColor}; color: white; border-radius: 3px; font-size: 10px; font-weight: bold; margin-bottom: 6px;">${esc(fac.brand)}</div>
            <div style="color: #4a5568; margin-bottom: 4px;">📍 ${esc(fac.address)}, ${esc(fac.city)} ${esc(fac.zipCode)}</div>
            ${fac.phone && !/^unknown$/i.test(fac.phone) ? `<div style="color: #4a5568; margin-bottom: 4px;">📞 ${esc(fac.phone)}</div>` : ''}
            <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #e2e8f0; font-weight: bold; color: #2b6cb0;">
              ${esc(unitSize)} rate: <span style="font-size: 14px;">${esc(rateText)}</span>${fac.street && fac.street > (fac.web || 0) ? ` <s style="color:#a0aec0;font-weight:400">$${fac.street}</s>` : ''}
            </div>
          </div>`;
        window.L.circleMarker([lat, lon], { radius: 7, fillColor: color, color: '#ffffff', weight: 2, opacity: 1, fillOpacity: 0.9 })
          .bindPopup(popupHtml).addTo(markers);
      });
      if (filtersActive && pts.length) {
        try { mapInstanceRef.current.fitBounds(pts, { padding: [30, 30], maxZoom: 13 }); } catch (e) { /* ignore */ }
      }
    }

    const resizeTimer = setTimeout(() => { if (mapInstanceRef.current) mapInstanceRef.current.invalidateSize(); }, 150);
    return () => clearTimeout(resizeTimer);
  }, [leafletReady, rows, priced, unitSize, viewMode, mapColor, filtersActive]);

  const exportCsv = () => {
    downloadCsv(`storage-facilities-${unitSize}-${new Date().toISOString().slice(0, 10)}.csv`, [
      { label: 'Facility', get: (r) => r.name }, { label: 'Brand', get: (r) => r.brand }, { label: 'Address', get: (r) => r.address },
      { label: 'City', get: (r) => r.city }, { label: 'State', get: (r) => r.state }, { label: 'ZIP', get: (r) => r.zipCode },
      { label: 'Phone', get: (r) => r.phone }, { label: 'Website', get: (r) => r.website },
      { label: `${unitSize} web rate`, get: (r) => r.web }, { label: `${unitSize} street rate`, get: (r) => r.street },
      { label: 'Web discount %', get: (r) => r.discountPct }, { label: 'Latitude', get: (r) => r.lat }, { label: 'Longitude', get: (r) => r.lon },
    ], sortedRows);
  };

  const lastScraped = kpis?.lastScraped ? new Date(kpis.lastScraped) : null;
  const staleDays = lastScraped ? Math.floor((Date.now() - lastScraped.getTime()) / 86400000) : null;
  const totalFacilities = facilities.length || kpis?.totalFacilities || 0;
  const shareParts = byBrand.map((b) => ({ key: b.brand, label: b.brand, color: b.color, n: b.facilities }));

  const th = (key, label) => (
    <th onClick={() => toggleSort(key)} style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '16px' }}>
        <div>
          <h1 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700 }}>Self-Storage Market Tracker</h1>
          <p style={{ margin: 0, color: '#718096', fontSize: '13px' }}>
            Competitor pricing, market share, and facility locations across Northern Virginia, DC, and Maryland.
          </p>
          {role === 'admin' && <div style={{ marginTop: '10px' }}><UpdatePricesButton backendUrl={backendUrl} /></div>}
        </div>
        <div style={{ display: 'flex', gap: '6px', backgroundColor: 'var(--bg-subtle, #edf2f7)', padding: '3px', borderRadius: '6px' }}>
          {[['dashboard', '📊 Map & Analytics'], ['table', `📋 Facility Directory (${rows.length})`]].map(([id, label]) => (
            <button key={id} onClick={() => setViewMode(id)} style={{
              padding: '6px 14px', borderRadius: '4px', border: 'none', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
              backgroundColor: viewMode === id ? 'var(--bg-card, #ffffff)' : 'transparent', color: viewMode === id ? '#2b6cb0' : '#4a5568',
              boxShadow: viewMode === id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}>{label}</button>
          ))}
        </div>
      </div>

      {staleDays !== null && staleDays > 7 && (
        <div style={{ backgroundColor: '#fffaf0', color: '#9c4221', border: '1px solid #fbd38d', padding: '9px 14px', borderRadius: '6px', fontSize: '12px', marginBottom: '14px' }}>
          ⚠️ Prices were last collected on <b>{lastScraped.toLocaleDateString()}</b> ({staleDays} days ago). Rates below are from that scrape; competitor prices may have changed since.
        </div>
      )}

      {/* Filters */}
      <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', padding: '12px 16px', marginBottom: '18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={LABEL}>Unit size</span>
            <select value={unitSize} onChange={(e) => setUnitSize(e.target.value)} style={{ ...INPUT, fontWeight: 600 }}>
              {UNIT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={LABEL}>City</span>
            <select value={city} onChange={(e) => setCity(e.target.value)} style={INPUT}>
              <option value="all">All cities</option>
              {cityOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={LABEL}>State</span>
            <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} style={INPUT}>
              <option value="all">All</option>
              {stateOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={LABEL}>{unitSize} rate $</span>
            <input type="number" min="0" placeholder="min" value={minRate} onChange={(e) => setMinRate(e.target.value)} style={{ ...INPUT, width: '70px' }} />
            <span style={{ color: '#a0aec0' }}>–</span>
            <input type="number" min="0" placeholder="max" value={maxRate} onChange={(e) => setMaxRate(e.target.value)} style={{ ...INPUT, width: '70px' }} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={onlyPriced} onChange={(e) => setOnlyPriced(e.target.checked)} />
            Only facilities with a rate
          </label>
          <input
            type="text" placeholder="🔍 Search name, city, ZIP, address…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            style={{ ...INPUT, flex: 1, minWidth: '220px' }}
          />
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={LABEL}>Brand</span>
          {brandOptions.map((b) => {
            const on = selectedBrands.includes(b);
            const c = getBrandColor(b);
            return (
              <button key={b} onClick={() => toggleBrand(b)} style={{
                padding: '4px 11px', borderRadius: '14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                border: `1.5px solid ${c}`, backgroundColor: on ? c : 'transparent', color: on ? '#fff' : c,
              }}>{b} <span style={{ opacity: 0.8, fontWeight: 500 }}>({allRows.filter((r) => r.brand === b).length})</span></button>
            );
          })}
          {filtersActive && (
            <button onClick={clearFilters} style={{ marginLeft: 'auto', padding: '4px 12px', borderRadius: '4px', border: '1px solid #cbd5e0', backgroundColor: 'transparent', fontSize: '12px', cursor: 'pointer', color: '#4a5568' }}>
              ✕ Clear filters
            </button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ backgroundColor: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2', padding: '10px 14px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' }}>{error}</div>
      )}

      {filtersActive && (
        <div style={{ fontSize: '12px', color: '#2b6cb0', marginBottom: '8px' }}>
          Showing <b>{rows.length}</b> of {totalFacilities} facilities ({priced.length} with a {unitSize} rate). Cards and charts below follow your filters.
        </div>
      )}

      {/* KPI cards (follow the filters) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '14px', marginBottom: '20px' }}>
        <Stat accent="#e91e63" label={filtersActive ? 'Facilities in view' : 'Tracked facilities'} valueColor="#2b6cb0" value={rows.length}
          sub={`${priced.length} with a ${unitSize} rate`} />
        <Stat accent="#00bcd4" label={`Avg ${unitSize} rate`} valueColor="#38a169" value={priced.length ? `${money(stats.avg)}/mo` : '—'}
          delta={filtersActive && priced.length && marketAvg ? <Delta pct={((stats.avg - marketAvg) / marketAvg) * 100} good={null} /> : null}
          sub={filtersActive ? 'vs. whole market' : `median ${money(stats.median)}`} />
        <Stat accent="#10b981" label="Lowest rate" value={stats.cheapest ? `${money(stats.cheapest.web)}/mo` : '—'}
          sub={stats.cheapest ? `${stats.cheapest.name}${stats.cheapest.city ? ` · ${stats.cheapest.city}` : ''}` : ''} />
        <Stat accent="#ef4444" label="Highest rate" value={stats.priciest ? `${money(stats.priciest.web)}/mo` : '—'}
          sub={stats.priciest ? `${stats.priciest.name}${stats.priciest.city ? ` · ${stats.priciest.city}` : ''}` : ''} />
        {stats.avgDiscount !== null
          ? <Stat accent="#ffc107" label="Avg web discount" valueColor="#805ad5" value={`${Math.round(stats.avgDiscount)}%`} sub="web rate vs. street rate" />
          : <Stat accent="#ffc107" label="Rate spread" valueColor="#805ad5" value={stats.cheapest ? money(stats.priciest.web - stats.cheapest.web) : '—'} sub="highest minus lowest rate" />}
        <Stat accent="#4caf50" label="Recent price records" valueColor="#4a5568" value={(kpis?.activeSnapshots || 0).toLocaleString()}
          sub={lastScraped ? `last 30 days · collected ${lastScraped.toLocaleDateString()}` : 'last 30 days'} />
      </div>

      {viewMode === 'dashboard' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '20px', marginBottom: '20px' }}>
            {/* Map */}
            <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1, isolation: 'isolate', overflow: 'hidden', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>📍 Facilities map</h3>
                  <span style={{ fontSize: '12px', color: '#718096' }}>Showing {rows.length} locations{loading ? ' · loading rates…' : ''}</span>
                </div>
                <div style={{ display: 'flex', gap: '4px', fontSize: '11px' }}>
                  {[['brand', 'Colour by brand'], ['price', 'Colour by price']].map(([id, label]) => (
                    <button key={id} onClick={() => setMapColor(id)} style={{
                      padding: '3px 9px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', border: '1px solid',
                      borderColor: mapColor === id ? '#3182ce' : '#cbd5e0', backgroundColor: mapColor === id ? '#ebf8ff' : 'transparent', color: mapColor === id ? '#2b6cb0' : '#4a5568',
                    }}>{label}</button>
                  ))}
                </div>
              </div>
              <div ref={mapContainerRef} style={{ width: '100%', height: '460px', borderRadius: '6px', border: '1px solid #e2e8f0', backgroundColor: '#e2e8f0' }} />
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', marginTop: '10px', color: '#4a5568' }}>
                {mapColor === 'brand'
                  ? byBrand.map((b) => <span key={b.brand} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '9px', height: '9px', borderRadius: '50%', backgroundColor: b.color }} />{b.brand}</span>)
                  : [['#10b981', 'Cheapest third'], ['#f59e0b', 'Middle third'], ['#ef4444', 'Priciest third'], ['#a0aec0', 'No rate']].map(([c, l]) => <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '9px', height: '9px', borderRadius: '50%', backgroundColor: c }} />{l}</span>)}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', minWidth: 0 }}>
              <Card title={`📏 ${unitSize} price range by brand`} subtitle="Bar spans lowest to highest rate; the solid tick is the average">
                <RangeBars rows={byBrand.filter((b) => b.rates.length).map((b) => ({ key: b.brand, label: b.brand, color: b.color, min: b.min, avg: b.avg, max: b.max, count: b.rates.length }))} />
              </Card>
              <Card title="🥧 Market share by brand" subtitle="Share of the facilities in view">
                <Donut parts={shareParts} centerLabel="facilities" />
              </Card>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '20px', marginBottom: '20px' }}>
            <Card title={`💵 How ${unitSize} rates are spread`} subtitle="Number of facilities per price band">
              <Histogram values={priced.map((r) => r.web)} markers={priced.length ? [{ label: 'Average', value: stats.avg, color: '#2b6cb0' }, { label: 'Median', value: stats.median, color: '#d69e2e' }] : []} />
            </Card>
            <Card title="🏙️ Average rate by city" subtitle={`Busiest cities (2+ facilities with a ${unitSize} rate), priciest first`}>
              <HBars rows={byCity.map((c) => ({ key: c.city, label: c.city, value: c.avg, sub: `${c.count} facilities`, color: '#3182ce' }))} />
            </Card>
            <Card title="🏷️ Street rate vs. web rate" subtitle="Average discount for booking online, by brand">
              {!byBrand.some((b) => b.avgDiscount !== null) ? (
                <Empty>{priced.length ? 'This price collection recorded the same street and web rate for every facility, so there is no online discount to compare.' : 'Nothing matches the current filters.'}</Empty>
              ) : <HBars
                format={(v) => `${Math.round(v)}%`}
                rows={byBrand.filter((b) => b.avgDiscount !== null).map((b) => ({ key: b.brand, label: b.brand, value: b.avgDiscount, sub: `${b.discounts.length} facilities`, color: b.color }))}
              />}
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '20px', marginBottom: '24px' }}>
            <Card title={`🟢 Lowest ${unitSize} rates`} subtitle="Click one to find it in the directory">
              <RankList rows={cheapest.map((r) => ({ key: r.id, title: `${r.name}${r.city ? ` — ${r.city}` : ''}`, sub: r.brand, value: r.web, color: getBrandColor(r.brand) }))}
                onPick={(r) => { setSearchQuery(r.title.split(' — ')[0]); setViewMode('table'); }} />
            </Card>
            <Card title={`🔴 Highest ${unitSize} rates`} subtitle="Where competitors charge the most">
              <RankList rows={priciest.map((r) => ({ key: r.id, title: `${r.name}${r.city ? ` — ${r.city}` : ''}`, sub: r.brand, value: r.web, color: getBrandColor(r.brand) }))}
                onPick={(r) => { setSearchQuery(r.title.split(' — ')[0]); setViewMode('table'); }} />
            </Card>
          </div>
        </>
      )}

      {/* Directory */}
      <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', overflowX: 'auto', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>🏢 Facilities &amp; current {unitSize} rates ({rows.length})</h3>
          <button onClick={exportCsv} disabled={!rows.length} style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid #cbd5e0', backgroundColor: 'transparent', fontSize: '12px', fontWeight: 600, cursor: rows.length ? 'pointer' : 'not-allowed', color: '#2b6cb0' }}>
            ⬇ Export CSV
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--bg-subtle, #f7fafc)', borderBottom: '1px solid #e2e8f0' }}>
              {th('name', 'Facility')}
              {th('brand', 'Brand')}
              {th('city', 'Location')}
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Phone</th>
              {th('web', `${unitSize} web rate`)}
              {th('street', 'Street rate')}
              {th('discount', 'Web discount')}
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>vs. average</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: '30px', textAlign: 'center', color: '#718096' }}>No facilities match your filters.</td></tr>
            ) : sortedRows.slice(0, visible).map((fac) => {
              const color = getBrandColor(fac.brand);
              return (
                <tr key={fac.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600 }}>{fac.name || `Facility #${fac.id}`}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, backgroundColor: `${color}20`, color, border: `1px solid ${color}40` }}>{fac.brand}</span>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#718096' }}>{fac.address ? `${fac.address}, ${fac.city || ''} ${fac.zipCode || ''}` : 'Northern Virginia'}</td>
                  <td style={{ padding: '12px 16px' }}>{fac.phone && !/^unknown$/i.test(fac.phone) ? <a href={`tel:${fac.phone}`} style={{ color: '#3182ce', textDecoration: 'none' }}>{fac.phone}</a> : '—'}</td>
                  <td style={{ padding: '12px 16px', color: '#2b6cb0', fontWeight: 700, fontSize: '14px' }}>{fac.web ? `$${fac.web}/mo` : 'Call for rate'}</td>
                  <td style={{ padding: '12px 16px', color: '#a0aec0', textDecoration: fac.street && fac.web && fac.street > fac.web ? 'line-through' : 'none' }}>{fac.street ? `$${fac.street}` : '—'}</td>
                  <td style={{ padding: '12px 16px' }}>{fac.discountPct !== null ? `${fac.discountPct}%` : '—'}</td>
                  <td style={{ padding: '12px 16px' }}>
                    {fac.web && stats.avg ? <Delta pct={((fac.web - stats.avg) / stats.avg) * 100} good={null} /> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sortedRows.length > visible && (
          <div style={{ padding: '12px', textAlign: 'center', borderTop: '1px solid #e2e8f0' }}>
            <button onClick={() => setVisible((v) => v + 100)} style={{ padding: '6px 16px', borderRadius: '4px', border: '1px solid #cbd5e0', backgroundColor: 'transparent', fontSize: '12px', fontWeight: 600, cursor: 'pointer', color: '#2b6cb0' }}>
              Show 100 more ({sortedRows.length - visible} remaining)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
