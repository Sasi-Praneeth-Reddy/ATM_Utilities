import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './mapview.css';
import { fetchMapJobs } from './mapApi';
import { todayLocalIso, shiftIso, fmtDate, fmtTime } from '../tasking/taskingUtils';

/**
 * Map module (read-only, every role). Two pages share this component:
 *  kind="local": the day's local jobs: curved line warehouse -> pickup (solid) and pickup -> drop-off (dashed).
 *  kind="ld":    long-distance trips running on the chosen day, same two lines.
 * Every job is a numbered dot (pickup filled, drop-off hollow); the list beside the map carries the same
 * numbers and the names. Only the selected job gets a name label on the map, so it never turns into a wall
 * of text. The map fills the page; the date bar and the job list float on top of it.
 * Straight-ish (curved) lines only, no routing. Motive is a placeholder.
 */

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f', '#ea580c', '#475569'];
const USA_BOUNDS = [[24.5, -125], [49.8, -66.5]];
const hasPt = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** "Harvey, Jakoy; KKFA0964220; MORV-D; CTI" -> "Harvey, Jakoy". Full text stays in the selected list row. */
export function shortName(customer) {
  const s = String(customer || '').split(';')[0].replace(/\*[A-Za-z]+\*/g, '').replace(/\s+/g, ' ').trim();
  return s || 'Customer';
}
/** "12 Main St #4, Sterling, VA 20166" -> "Sterling, VA". */
function cityState(addr) {
  if (!addr) return '';
  const parts = String(addr).split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  const last = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, '').trim();
  const prev = parts[parts.length - 2];
  return last ? `${prev}, ${last}` : prev;
}

/** Gentle quadratic curve between two points so lines leaving the same warehouse fan out instead of stacking. */
function curve(a, b, bend) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const cx = mx - dy * bend, cy = my + dx * bend;
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28, u = 1 - t;
    pts.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
  }
  return pts;
}

/** Small direction arrowheads along a drawn curve (screen-space angle from lat/lng, so they stay right at any zoom). */
function arrowsOn(group, pts, color, opacity) {
  [0.5, 0.88].forEach((t) => {
    const i = Math.max(1, Math.min(pts.length - 1, Math.round(t * (pts.length - 1))));
    const a = pts[i - 1], b = pts[i];
    const deg = (Math.atan2(b[0] - a[0], (b[1] - a[1]) * Math.cos((b[0] * Math.PI) / 180)) * 180) / Math.PI;
    L.marker(b, {
      interactive: false, keyboard: false, zIndexOffset: 50,
      icon: L.divIcon({ className: 'mv-pin-wrap', iconSize: [14, 14], iconAnchor: [7, 7], html: `<div class="mv-arrow" style="color:${color};opacity:${opacity};transform:rotate(${90 - deg}deg)">▶</div>` }),
    }).addTo(group);
  });
}

function dotIcon(n, color, hollow, dim, sel) {
  const size = sel ? 30 : 26;
  return L.divIcon({
    className: 'mv-pin-wrap',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="mv-pin ${hollow ? 'hollow' : ''} ${dim ? 'dim' : ''} ${sel ? 'sel' : ''}" style="--c:${color}">${n}</div>`,
  });
}

export default function MapView({ backendUrl, kind }) {
  const [date, setDate] = useState(todayLocalIso());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const fitted = useRef('');
  const pointsRef = useRef([]);

  // Load (and re-load every 3 s while the server is still geocoding new addresses).
  useEffect(() => {
    let alive = true;
    let timer;
    setData(null); setError(''); setSelected(null);
    const load = async (attempt) => {
      try {
        const d = await fetchMapJobs(backendUrl, date, kind);
        if (!alive) return;
        setData(d);
        if (d.pending > 0 && attempt < 40) timer = setTimeout(() => load(attempt + 1), 3000);
      } catch (err) { if (alive) setError(err.message); }
    };
    load(0);
    return () => { alive = false; clearTimeout(timer); };
  }, [backendUrl, date, kind]);

  // Create the Leaflet map once.
  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: 'bottomleft' }).addTo(map.current);
    map.current.fitBounds(kind === 'ld' ? USA_BOUNDS : [[38.6, -77.9], [39.3, -76.9]]);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    map.current.on('click', () => setSelected(null));
    return () => { map.current.remove(); map.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const colorOf = useCallback((job, i) => (job.trucks[0] && job.trucks[0].color) || PALETTE[i % PALETTE.length], []);

  // Draw.
  useEffect(() => {
    if (!map.current || !layer.current) return;
    layer.current.clearLayers();
    if (!data) return;
    const bounds = [];
    const wh = data.warehouse;
    const whPt = hasPt(wh) ? [wh.lat, wh.lng] : null;
    if (whPt) {
      L.marker(whPt, { icon: L.divIcon({ className: 'mv-pin-wrap', iconSize: [34, 34], iconAnchor: [17, 17], html: '<div class="mv-wh">WH</div>' }), zIndexOffset: -200 })
        .bindTooltip('ATM warehouse · Sterling, VA', { direction: 'top', offset: [0, -14] }).addTo(layer.current);
      bounds.push(whPt);
    }
    data.jobs.forEach((job, i) => {
      const n = i + 1;
      const c = colorOf(job, i);
      const isSel = selected === job.id;
      const dim = !!selected && !isSel;
      const op = dim ? 0.25 : 0.95;
      const w = isSel ? 5 : dim ? 2 : 3;
      const o = hasPt(job.origin) ? [job.origin.lat, job.origin.lng] : null;
      const d = hasPt(job.destination) ? [job.destination.lat, job.destination.lng] : null;
      const bend = (i % 2 ? -1 : 1) * (0.1 + 0.04 * (i % 4));
      const pick = (e) => { if (e && e.originalEvent) L.DomEvent.stopPropagation(e); setSelected((s) => (s === job.id ? null : job.id)); };
      const name = esc(shortName(job.customer));
      const when = kind === 'ld' ? `${fmtDate(job.date)} → ${fmtDate(job.endDate)}` : fmtTime(job.startTime);
      const tip = `<b>${n}. ${name}</b><br>${esc(when)}${job.trucks.length ? ' · ' + esc(job.trucks.map((t) => t.name).join(', ')) : ''}`;
      // Approach (warehouse -> pickup): thinner and lighter. The actual trip (pickup -> drop-off): heavier, dashed.
      // Arrowheads on both show the direction, so a drop-off near the warehouse is not read as "coming back".
      if (whPt && o) {
        const pts = curve(whPt, o, bend);
        L.polyline(pts, { color: c, weight: Math.max(2, w - 1), opacity: op * 0.7, lineCap: 'round' }).addTo(layer.current);
        arrowsOn(layer.current, pts, c, op * 0.8);
      }
      if (o && d) {
        const pts = curve(o, d, bend);
        L.polyline(pts, { color: c, weight: w + 1, opacity: op, dashArray: '9 7', lineCap: 'round' }).addTo(layer.current);
        arrowsOn(layer.current, pts, c, op);
      }
      const mk = (pt, hollow, suffix) => {
        const m = L.marker(pt, { icon: dotIcon(n, c, hollow, dim, isSel), zIndexOffset: isSel ? 900 : 100 + i }).on('click', pick).addTo(layer.current);
        if (isSel) m.bindTooltip(`<b>${name}</b> · ${suffix}`, { permanent: true, direction: 'top', offset: [0, -16], className: 'mv-label', opacity: 1 });
        else m.bindTooltip(`${tip}<br><i>${suffix}</i>`, { direction: 'top', offset: [0, -14] });
        bounds.push(pt);
      };
      if (o) mk(o, false, 'pickup');
      if (d) mk(d, true, 'drop-off');
    });
    pointsRef.current = bounds;

    // Re-fit only when the day/page changes (or points first arrive), so selecting a job never moves the map.
    const sig = `${date}|${kind}|${bounds.length > 1}`;
    if (fitted.current !== sig) {
      if (bounds.length > 1) map.current.fitBounds(bounds, { paddingTopLeft: [60, 90], paddingBottomRight: [panelOpen && window.innerWidth > 900 ? 380 : 60, 60], maxZoom: 12 });
      else if (kind === 'ld') map.current.fitBounds(USA_BOUNDS);
      fitted.current = sig;
    }
  }, [data, selected, kind, date, colorOf]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the selected job's pins in view when picked from the list.
  useEffect(() => {
    if (!selected || !data || !map.current) return;
    const j = data.jobs.find((x) => x.id === selected);
    if (!j) return;
    const pts = [j.origin, j.destination].filter(hasPt).map((p) => [p.lat, p.lng]);
    if (!pts.length) return;
    const b = L.latLngBounds(pts);
    if (!map.current.getBounds().pad(-0.1).contains(b)) map.current.fitBounds(b.pad(0.4), { maxZoom: 12 });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => (data ? data.jobs : []), [data]);
  const fit = (b, opts) => map.current && map.current.fitBounds(b, opts);

  return (
    <div className="mv-stage">
      <div className="mv-map" ref={el} />

      <div className="mv-float mv-bar">
        <div className="mv-datepick">
          <button className="mv-ico" aria-label="Previous day" onClick={() => setDate(shiftIso(date, -1))}>‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="mv-ico" aria-label="Next day" onClick={() => setDate(shiftIso(date, 1))}>›</button>
        </div>
        <button className="mv-chip" onClick={() => setDate(todayLocalIso())}>Today</button>
        <span className="mv-sep" />
        <strong className="mv-title">{fmtDate(date)}</strong>
        {kind === 'ld' && <button className="mv-chip" onClick={() => fit(USA_BOUNDS)}>Whole USA</button>}
        <button className="mv-chip" disabled={!data || list.length === 0} onClick={() => fit(pointsRef.current, { padding: [70, 70], maxZoom: 12 })}>{kind === 'ld' ? 'Zoom to trips' : 'Fit jobs'}</button>
        <label className="mv-motive" title="Live truck positions from Motive are coming next"><input type="checkbox" disabled /> Motive</label>
      </div>

      <div className="mv-float mv-legend" aria-hidden="true">
        <span><i className="mv-lg-solid" /> Warehouse → pickup</span>
        <span><i className="mv-lg-dash" /> Pickup → drop-off (the trip)</span>
        <span><i className="mv-lg-pin" /> Pickup <i className="mv-lg-pin hollow" /> Drop-off</span>
      </div>

      {error && <div className="mv-float mv-error">{error}</div>}
      {data && data.pending > 0 && <div className="mv-float mv-toast">Locating {data.pending} new address{data.pending === 1 ? '' : 'es'}…</div>}

      <aside className={`mv-float mv-panel ${panelOpen ? '' : 'closed'}`}>
        <button className="mv-panel-head" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}>
          <span className="mv-panel-title">{kind === 'ld' ? 'Long-distance trips' : 'Jobs'}</span>
          <span className="mv-count">{data ? list.length : '…'}</span>
          <span className="mv-caret">{panelOpen ? '▾' : '▴'}</span>
        </button>
        {panelOpen && (
          <div className="mv-rows">
            {!data && !error && <div className="mv-empty">Loading…</div>}
            {data && list.length === 0 && <div className="mv-empty">{kind === 'ld' ? 'No long-distance trips on this day.' : 'No jobs on this day.'}</div>}
            {list.map((j, i) => {
              const on = selected === j.id;
              const missing = ((j.origin && !hasPt(j.origin)) || (j.destination && !hasPt(j.destination))) && !(data && data.pending > 0);
              return (
                <button key={j.id} className={`mv-row ${on ? 'on' : ''}`} onClick={() => setSelected(on ? null : j.id)}>
                  <span className="mv-num" style={{ '--c': colorOf(j, i) }}>{i + 1}</span>
                  <span className="mv-rowtxt">
                    <b>{shortName(j.customer)}</b>
                    <small>{kind === 'ld' ? `${fmtDate(j.date)} → ${fmtDate(j.endDate)}` : fmtTime(j.startTime)}{j.trucks.length ? ` · ${j.trucks.map((t) => t.name).join(', ')}` : ''}</small>
                    <small className="mv-route">{cityState(j.origin && j.origin.address) || '—'}{j.destination ? ` → ${cityState(j.destination.address)}` : ''}</small>
                    {on && (
                      <span className="mv-detail">
                        {j.customer !== shortName(j.customer) && <small>{j.customer}</small>}
                        {j.origin && <small>Pickup: {j.origin.address}</small>}
                        {j.destination && <small>Drop-off: {j.destination.address}</small>}
                      </span>
                    )}
                    {missing && <small className="mv-warn">Address not found on map</small>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </aside>
    </div>
  );
}
