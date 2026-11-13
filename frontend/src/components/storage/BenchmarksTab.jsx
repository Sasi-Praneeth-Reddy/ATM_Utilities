import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../api';
import { monthLabel } from '../leads/LeadsCharts';
import { Card, Empty, LineChart, PairedColumns, SeasonHeat, Stat, Delta, money, moneyShort, downloadCsv } from './MarketCharts';

const SOURCE_COLORS = { NVAR: '#3182ce', 'Bright MLS': '#f97316' };
const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString());

// metric key -> how to read/format it, and whether "up" is good news for a mover/storage business
const METRICS = [
  { key: 'medianClosePrice', label: 'Median close price', fmt: money, axis: moneyShort, good: null },
  { key: 'closedSales', label: 'Closed sales', fmt: num, axis: num, good: true },
  { key: 'newListings', label: 'New listings', fmt: num, axis: num, good: true },
  { key: 'activeListings', label: 'Active listings', fmt: num, axis: num, good: null },
  { key: 'medianDaysOnMarket', label: 'Median days on market', fmt: (v) => (v === null || v === undefined ? '—' : `${v}d`), axis: (v) => `${Math.round(v)}d`, good: null },
  { key: 'closeToListRatio', label: 'Close-to-list ratio', fmt: (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`), axis: (v) => `${v.toFixed(1)}%`, good: null },
  { key: 'monthsSupply', label: 'Months of supply', fmt: (v) => (v === null || v === undefined ? '—' : v.toFixed(2)), axis: (v) => v.toFixed(1), good: null },
];

const LABEL = { fontSize: '11px', fontWeight: 700, color: 'var(--m-text-2)', textTransform: 'uppercase', letterSpacing: '0.02em' };
const INPUT = { padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--m-border-strong)', fontSize: '12px', backgroundColor: 'var(--bg-card, #ffffff)', color: 'var(--text-main, #2d3748)' };

const monthKey = (b) => String(b.periodDate || '').slice(0, 7);
const prevMonth = (k) => { const [y, m] = k.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const prevYear = (k) => `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`;
const pctChange = (now, before) => (before ? ((now - before) / before) * 100 : null);

export default function BenchmarksTab({ backendUrl }) {
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [source, setSource] = useState('all');
  const [region, setRegion] = useState('all');
  const [fromMonth, setFromMonth] = useState('');
  const [toMonth, setToMonth] = useState('');
  const [metric, setMetric] = useState('medianClosePrice');
  const [sort, setSort] = useState({ key: 'period', dir: 'desc' });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const res = await apiCall(backendUrl, 'GET', '/api/storage/benchmarks');
        if (active) {
          setAll((res || []).map((b) => ({
            ...b,
            month: monthKey(b),
            monthsSupply: b.closedSales ? b.activeListings / b.closedSales : null,
          })));
        }
      } catch (err) {
        if (active) setError(`Failed to load benchmarks: ${err.message}`);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [backendUrl]);

  const sources = useMemo(() => [...new Set(all.map((b) => b.source).filter(Boolean))].sort(), [all]);
  const regions = useMemo(() => [...new Set(all.map((b) => b.region).filter(Boolean))].sort(), [all]);
  const monthOptions = useMemo(() => [...new Set(all.map((b) => b.month))].sort(), [all]);

  const filtersActive = source !== 'all' || region !== 'all' || fromMonth !== '' || toMonth !== '';
  const clearFilters = () => { setSource('all'); setRegion('all'); setFromMonth(''); setToMonth(''); };

  // Rows after the filters (chronological)
  const rows = useMemo(() => all.filter((b) => (
    (source === 'all' || b.source === source) && (region === 'all' || b.region === region)
    && (!fromMonth || b.month >= fromMonth) && (!toMonth || b.month <= toMonth)
  )).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.source < b.source ? -1 : 1)), [all, source, region, fromMonth, toMonth]);

  // The "primary" source drives the KPI cards, season table and sales chart: the chosen one, else the one with the most months.
  const primary = useMemo(() => {
    if (source !== 'all') return source;
    const counts = {};
    rows.forEach((r) => { counts[r.source] = (counts[r.source] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }, [rows, source]);
  const primaryRows = useMemo(() => rows.filter((r) => r.source === primary), [rows, primary]);

  const labels = useMemo(() => [...new Set(rows.map((r) => r.month))].sort(), [rows]);
  const cfg = METRICS.find((m) => m.key === metric) || METRICS[0];

  const series = useMemo(() => {
    const srcs = source === 'all' ? sources.filter((s) => rows.some((r) => r.source === s)) : [source];
    return srcs.map((s) => ({
      key: s,
      name: s,
      color: SOURCE_COLORS[s] || '#64748b',
      values: labels.map((l) => {
        const r = rows.find((x) => x.source === s && x.month === l);
        return r && r[metric] !== null && r[metric] !== undefined ? r[metric] : null;
      }),
    }));
  }, [rows, labels, metric, source, sources]);

  // Latest period for the primary source, with month-on-month and year-on-year change (from the full data, not the date filter)
  const latest = primaryRows.length ? primaryRows[primaryRows.length - 1] : null;
  const lookup = (key) => all.find((b) => b.source === primary && b.region === latest?.region && b.month === key);
  const prevM = latest ? lookup(prevMonth(latest.month)) : null;
  const prevY = latest ? lookup(prevYear(latest.month)) : null;

  const kpiCard = (m, accent) => {
    if (!latest) return null;
    const v = latest[m.key];
    const mom = prevM ? pctChange(v, prevM[m.key]) : null;
    const yoy = prevY ? pctChange(v, prevY[m.key]) : null;
    return (
      <Stat key={m.key} accent={accent} label={m.label} value={m.fmt(v)}
        delta={<>
          {yoy !== null && <span title="vs. same month last year"><Delta pct={yoy} good={m.good} suffix=" YoY" /></span>}
          {mom !== null && <span title="vs. previous month"><Delta pct={mom} good={m.good} suffix=" MoM" /></span>}
        </>}
        sub={yoy === null && mom === null ? 'no earlier month to compare' : ''} />
    );
  };

  const salesRows = primaryRows.map((r) => ({ key: `${r.month}`, label: monthLabel(r.month, false).slice(0, 3) + (r.month.slice(5) === '01' ? ` ’${r.month.slice(2, 4)}` : ''), a: r.closedSales, b: r.newListings }));
  const supplySeries = useMemo(() => [{ key: 'supply', name: `${primary || ''} months of supply`, color: '#805ad5', values: primaryRows.map((r) => r.monthsSupply) }], [primaryRows, primary]);
  const heatCells = useMemo(() => {
    const out = {};
    primaryRows.forEach((r) => { if (r[metric] !== null && r[metric] !== undefined) out[r.month] = r[metric]; });
    return out;
  }, [primaryRows, metric]);

  // Source comparison on months both report
  const overlap = useMemo(() => {
    if (sources.length < 2) return [];
    const [a, b] = ['NVAR', 'Bright MLS'].filter((s) => sources.includes(s));
    if (!a || !b) return [];
    return labels.map((l) => {
      const ra = rows.find((r) => r.source === a && r.month === l);
      const rb = rows.find((r) => r.source === b && r.month === l);
      return ra && rb ? { key: l, label: monthLabel(l), a: ra.medianClosePrice, b: rb.medianClosePrice, nameA: a, nameB: b } : null;
    }).filter(Boolean);
  }, [rows, labels, sources]);

  const tableRows = useMemo(() => {
    const get = {
      period: (r) => r.month, source: (r) => r.source, region: (r) => r.region, closedSales: (r) => r.closedSales, newListings: (r) => r.newListings,
      activeListings: (r) => r.activeListings, medianDaysOnMarket: (r) => r.medianDaysOnMarket, medianClosePrice: (r) => r.medianClosePrice,
      closeToListRatio: (r) => r.closeToListRatio, monthsSupply: (r) => r.monthsSupply,
    }[sort.key];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return x < y ? -dir : x > y ? dir : 0;
    });
  }, [rows, sort]);
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'source' || key === 'region' ? 'asc' : 'desc' }));

  const exportCsv = () => downloadCsv(`market-benchmarks-${new Date().toISOString().slice(0, 10)}.csv`, [
    { label: 'Period', get: (r) => r.periodDate }, { label: 'Source', get: (r) => r.source }, { label: 'Region', get: (r) => r.region },
    { label: 'Closed sales', get: (r) => r.closedSales }, { label: 'New listings', get: (r) => r.newListings }, { label: 'Active listings', get: (r) => r.activeListings },
    { label: 'Pending sales', get: (r) => r.pendingSales }, { label: 'Median days on market', get: (r) => r.medianDaysOnMarket },
    { label: 'Median close price', get: (r) => r.medianClosePrice }, { label: 'Average close price', get: (r) => r.avgClosePrice },
    { label: 'Close-to-list %', get: (r) => r.closeToListRatio }, { label: 'Months of supply', get: (r) => (r.monthsSupply === null ? '' : r.monthsSupply.toFixed(2)) },
  ], tableRows);

  const th = (key, label) => (
    <th onClick={() => toggleSort(key)} style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--m-text-2)', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div>
      <div style={{ marginBottom: '16px' }}>
        <h1 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700 }}>Real Estate Market Benchmarks</h1>
        <p style={{ margin: 0, color: 'var(--m-muted)', fontSize: '13px' }}>Monthly housing-market comparisons from NVAR and Bright MLS. Housing activity is a leading signal for moving and storage demand.</p>
      </div>

      {/* Filters */}
      <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, var(--m-border))', borderRadius: '8px', padding: '12px 16px', marginBottom: '18px', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={LABEL}>Source</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={INPUT}>
            <option value="all">All sources</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {regions.length > 1 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={LABEL}>Region</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)} style={INPUT}>
              <option value="all">All regions</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={LABEL}>From</span>
          <select value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} style={INPUT}>
            <option value="">Earliest</option>
            {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={LABEL}>To</span>
          <select value={toMonth} onChange={(e) => setToMonth(e.target.value)} style={INPUT}>
            <option value="">Latest</option>
            {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={LABEL}>Chart metric</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value)} style={{ ...INPUT, fontWeight: 600 }}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
        {filtersActive && (
          <button onClick={clearFilters} style={{ marginLeft: 'auto', padding: '4px 12px', borderRadius: '4px', border: '1px solid var(--m-border-strong)', backgroundColor: 'transparent', fontSize: '12px', cursor: 'pointer', color: 'var(--m-text-2)' }}>✕ Clear filters</button>
        )}
      </div>

      {error && <div style={{ backgroundColor: 'var(--tint-red-bg)', color: 'var(--m-red)', border: '1px solid var(--tint-red-border)', padding: '10px 14px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' }}>{error}</div>}

      {loading && !all.length ? <Empty>Loading benchmarks…</Empty> : !rows.length ? (
        <Empty>{all.length ? 'No months match these filters.' : 'No benchmark records found.'}</Empty>
      ) : (
        <>
          {latest && (
            <div style={{ fontSize: '12px', color: 'var(--m-muted)', marginBottom: '8px' }}>
              Latest {primary} report: <b>{monthLabel(latest.month)}</b> · {latest.region}. Arrows compare with the same month last year and the month before.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', marginBottom: '20px' }}>
            {kpiCard(METRICS[0], '#3182ce')}
            {kpiCard(METRICS[1], '#38a169')}
            {kpiCard(METRICS[2], '#10b981')}
            {kpiCard(METRICS[4], '#e53e3e')}
            {kpiCard(METRICS[5], '#d69e2e')}
            {kpiCard(METRICS[6], '#805ad5')}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '20px', marginBottom: '20px' }}>
            <Card title={`📈 ${cfg.label} over time`} subtitle={source === 'all' && series.length > 1 ? 'Each source on its own line; hover for exact values' : 'Hover a point for the exact value'}>
              <LineChart labels={labels.map((l) => monthLabel(l, false).slice(0, 3) + ` ’${l.slice(2, 4)}`)} series={series} format={cfg.axis} />
            </Card>
            <Card title="🏠 Buyers vs. sellers" subtitle={`${primary || ''}: homes sold each month against new homes listed`}>
              <PairedColumns rows={salesRows} aLabel="Closed sales" bLabel="New listings" />
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '20px', marginBottom: '20px' }}>
            <Card title="🗓️ Seasonality" subtitle={`${cfg.label} by month and year (${primary || ''}) — darker is higher`}>
              <SeasonHeat cells={heatCells} format={cfg.axis} />
            </Card>
            <Card title="⚖️ Months of supply" subtitle="Active listings ÷ monthly sales. Under 3 favours sellers, over 6 favours buyers.">
              <LineChart labels={primaryRows.map((r) => monthLabel(r.month, false).slice(0, 3) + ` ’${r.month.slice(2, 4)}`)} series={supplySeries} format={(v) => v.toFixed(1)} height={200} />
            </Card>
          </div>

          {overlap.length > 0 && (
            <div style={{ marginBottom: '20px' }}>
              <Card title="🔀 NVAR vs. Bright MLS" subtitle="Median close price in the months both sources report">
                <PairedColumns rows={overlap.map((o) => ({ key: o.key, label: o.label, a: o.a, b: o.b }))} aLabel={overlap[0].nameA} bLabel={overlap[0].nameB} aColor={SOURCE_COLORS[overlap[0].nameA]} bColor={SOURCE_COLORS[overlap[0].nameB]} height={170} />
              </Card>
            </div>
          )}
        </>
      )}

      {/* History table */}
      <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, var(--m-border))', borderRadius: '8px', overflowX: 'auto', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--m-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>📋 Monthly history ({rows.length})</h3>
          <button onClick={exportCsv} disabled={!rows.length} style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--m-border-strong)', backgroundColor: 'transparent', fontSize: '12px', fontWeight: 600, cursor: rows.length ? 'pointer' : 'not-allowed', color: 'var(--m-blue)' }}>⬇ Export CSV</button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--bg-subtle, var(--m-surface-2))', borderBottom: '1px solid var(--m-border)' }}>
              {th('period', 'Period')}
              {th('source', 'Source')}
              {th('region', 'Region')}
              {th('closedSales', 'Closed sales')}
              {th('newListings', 'New listings')}
              {th('activeListings', 'Active')}
              {th('medianDaysOnMarket', 'Median days')}
              {th('medianClosePrice', 'Median price')}
              {th('closeToListRatio', 'Close / list')}
              {th('monthsSupply', 'Supply (mo)')}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} style={{ padding: '30px', textAlign: 'center', color: 'var(--m-muted)' }}>Loading benchmarks…</td></tr>
            ) : tableRows.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: '30px', textAlign: 'center', color: 'var(--m-muted)' }}>No records match these filters.</td></tr>
            ) : tableRows.map((b) => (
              <tr key={b.id || `${b.source}-${b.periodDate}`} style={{ borderBottom: '1px solid var(--m-border)' }}>
                <td style={{ padding: '12px 16px', fontWeight: 600 }}>{b.periodDate}</td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, color: SOURCE_COLORS[b.source] || '#4a5568', backgroundColor: `${SOURCE_COLORS[b.source] || '#64748b'}1a` }}>{b.source}</span>
                </td>
                <td style={{ padding: '12px 16px', color: 'var(--m-muted)' }}>{b.region}</td>
                <td style={{ padding: '12px 16px', fontWeight: 600, color: '#38a169' }}>{b.closedSales ? num(b.closedSales) : '—'}</td>
                <td style={{ padding: '12px 16px' }}>{b.newListings ? num(b.newListings) : '—'}</td>
                <td style={{ padding: '12px 16px' }}>{b.activeListings ? num(b.activeListings) : '—'}</td>
                <td style={{ padding: '12px 16px' }}>{b.medianDaysOnMarket || '—'}</td>
                <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--m-blue)' }}>{b.medianClosePrice ? money(b.medianClosePrice) : '—'}</td>
                <td style={{ padding: '12px 16px' }}>{b.closeToListRatio ? `${b.closeToListRatio}%` : '—'}</td>
                <td style={{ padding: '12px 16px' }}>{b.monthsSupply !== null ? b.monthsSupply.toFixed(2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
