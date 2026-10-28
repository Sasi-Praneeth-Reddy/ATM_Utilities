import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchListings, fetchMatchedLeads, fetchLegacyCustomers, downloadListingsCsv, saveBlob } from './leadsApi';
import { monthLabel } from './LeadsCharts';

// Spreadsheet-style view of all lead data. Three linked sheets (like tabs in an Excel workbook):
//   Listings  <->  VIP Matches  <->  Past Customers
// Blue cells are relations: click one to jump to the related rows on the other sheet.

const PAGE = 100;
const money = (v) => (v || v === 0 ? `$${Number(v).toLocaleString()}` : '');

const SHEETS = {
  listings: { label: 'Listings' },
  matches: { label: 'VIP Matches' },
  customers: { label: 'Past Customers' },
};

function csvEscape(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // formula-injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function LeadsSheet({ backendUrl, months = [] }) {
  const [sheet, setSheet] = useState('listings');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [month, setMonth] = useState('all');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(null); // { key, dir }
  const [selected, setSelected] = useState(null); // { r, c }
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [listings, setListings] = useState({ rows: [], total: 0 });
  const [matches, setMatches] = useState(null); // null = not loaded yet
  const [customers, setCustomers] = useState(null);
  const cursorsRef = useRef({});

  // Matches are small and power the relation columns, so load them once up front.
  useEffect(() => {
    let alive = true;
    fetchMatchedLeads(backendUrl, 'all').then((m) => alive && setMatches(Array.isArray(m) ? m : [])).catch(() => alive && setMatches([]));
    return () => { alive = false; };
  }, [backendUrl]);

  useEffect(() => {
    if (sheet !== 'customers' || customers) return undefined;
    let alive = true;
    fetchLegacyCustomers(backendUrl).then((c) => alive && setCustomers(Array.isArray(c) ? c : [])).catch((e) => { if (alive) { setCustomers([]); setError(e.message); } });
    return () => { alive = false; };
  }, [sheet, customers, backendUrl]);

  useEffect(() => { setPage(1); }, [search, status, month, sheet]);

  // Listings are paged from the server (27K rows); the other sheets are filtered in the browser.
  useEffect(() => {
    if (sheet !== 'listings') return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const sig = [search, status, month].join('|');
        const after = page > 1 ? cursorsRef.current[`${sig}:${page - 1}`] : undefined;
        const res = await fetchListings(backendUrl, { search, status, month, limit: PAGE, offset: (page - 1) * PAGE, after });
        if (res?.endCursor) cursorsRef.current[`${sig}:${page}`] = res.endCursor;
        if (alive && res) setListings({ rows: res.leads || [], total: res.total ?? (res.leads || []).length });
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [backendUrl, sheet, search, status, month, page]);

  const matchesByAddress = useMemo(() => {
    const map = new Map();
    (matches || []).forEach((m) => {
      const k = String(m.matchedAddress || '').toLowerCase();
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    });
    return map;
  }, [matches]);

  const matchCountByName = useMemo(() => {
    const map = new Map();
    (matches || []).forEach((m) => {
      const k = String(m.customerName || '').toLowerCase();
      if (k) map.set(k, (map.get(k) || 0) + 1);
    });
    return map;
  }, [matches]);

  function jump(toSheet, text) {
    setSheet(toSheet);
    setSearch(text || '');
    setStatus('all');
    setMonth('all');
    setSort(null);
    setSelected(null);
  }

  // Column definitions. `link` cells are relations to another sheet.
  const columns = useMemo(() => {
    if (sheet === 'listings') {
      return [
        { key: 'listedDate', label: 'Listed', w: 96 },
        { key: 'status', label: 'Status', w: 120 },
        { key: 'address', label: 'Address', w: 230 },
        { key: 'city', label: 'City', w: 130 },
        { key: 'state', label: 'St', w: 48 },
        { key: 'zipCode', label: 'ZIP', w: 72 },
        { key: 'county', label: 'County', w: 170 },
        { key: 'listPrice', label: 'List price', w: 110, num: true, fmt: money },
        { key: 'bedrooms', label: 'Beds', w: 56, num: true },
        { key: 'bathrooms', label: 'Baths', w: 60, num: true },
        { key: 'sqft', label: 'Sq ft', w: 74, num: true },
        { key: 'ownerFullName', label: 'Owner', w: 160 },
        { key: 'phone', label: 'Owner phone', w: 120 },
        { key: 'email', label: 'Owner email', w: 200 },
        { key: 'realtorName', label: 'Realtor', w: 160 },
        { key: 'realtorPhone', label: 'Realtor phone', w: 120 },
        { key: 'brokerName', label: 'Broker', w: 170 },
        {
          key: '_matches', label: 'Matched customers ↗', w: 200,
          get: (r) => (matchesByAddress.get(String(r.address || '').toLowerCase()) || []).map((m) => m.customerName).join(', '),
          link: (r) => jump('matches', r.address),
        },
      ];
    }
    if (sheet === 'matches') {
      return [
        { key: 'status', label: 'Review status', w: 110 },
        { key: 'customerName', label: 'Customer', w: 170, link: (r) => jump('customers', r.customerName), linkLabel: '↗' },
        { key: 'customerEmail', label: 'Email', w: 200 },
        { key: 'customerPhone', label: 'Phone', w: 120 },
        { key: 'matchedAddress', label: 'Listing address ↗', w: 240, link: (r) => jump('listings', r.matchedAddress) },
        { key: 'matchedType', label: 'Match type', w: 110 },
        { key: 'confidence', label: 'Confidence', w: 90, num: true },
        { key: 'previousMoveDate', label: 'Past move', w: 100 },
        { key: 'listingStatus', label: 'Listing status', w: 110 },
        { key: 'listingPrice', label: 'List price', w: 110, num: true, fmt: money },
        { key: 'listedDate', label: 'Listed', w: 96 },
        { key: 'realtorName', label: 'Realtor', w: 160 },
        { key: 'matchReason', label: 'Why matched', w: 260 },
        { key: 'notes', label: 'Notes', w: 200 },
      ];
    }
    return [
      { key: 'name', label: 'Customer', w: 180 },
      { key: 'email', label: 'Email', w: 210 },
      { key: 'phone', label: 'Phone', w: 130 },
      { key: 'originAddress', label: 'Moved from', w: 250 },
      { key: 'destinationAddress', label: 'Moved to', w: 250 },
      { key: 'city', label: 'City', w: 120 },
      { key: 'state', label: 'St', w: 48 },
      { key: 'zip', label: 'ZIP', w: 72 },
      { key: 'moveDate', label: 'Move date', w: 100 },
      {
        key: '_matches', label: 'VIP matches ↗', w: 110, num: true,
        get: (r) => matchCountByName.get(String(r.name || '').toLowerCase()) || 0,
        link: (r) => ((matchCountByName.get(String(r.name || '').toLowerCase()) || 0) ? jump('matches', r.name) : null),
      },
      { key: 'notes', label: 'Notes', w: 200 },
    ];
  }, [sheet, matchesByAddress, matchCountByName]);

  const cellValue = (col, row) => (col.get ? col.get(row) : row[col.key]);
  const cellText = (col, row) => {
    const v = cellValue(col, row);
    if (v === null || v === undefined || v === '') return '';
    return col.fmt ? col.fmt(v) : String(v);
  };

  // Rows for the active sheet (listings: already filtered by the server; others: filtered here)
  const baseRows = sheet === 'listings' ? listings.rows : sheet === 'matches' ? (matches || []) : (customers || []);
  const rows = useMemo(() => {
    let out = baseRows;
    if (sheet !== 'listings') {
      const q = search.trim().toLowerCase();
      if (q) out = out.filter((r) => columns.some((c) => cellText(c, r).toLowerCase().includes(q)));
      if (sheet === 'matches' && status !== 'all') out = out.filter((r) => r.status === status);
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        out = [...out].sort((a, b) => {
          const va = cellValue(col, a); const vb = cellValue(col, b);
          const cmp = col.num ? (Number(va) || 0) - (Number(vb) || 0) : String(va ?? '').localeCompare(String(vb ?? ''));
          return sort.dir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRows, sheet, search, status, sort, columns]);

  const shownRows = sheet === 'listings' ? rows : rows.slice((page - 1) * PAGE, page * PAGE);
  const total = sheet === 'listings' ? listings.total : rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  function toggleSort(key) {
    setSort((s) => (!s || s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  }

  async function exportCsv() {
    setNote('');
    setError('');
    try {
      if (sheet === 'listings') {
        setNote('Preparing export of every listing that matches these filters…');
        const n = await downloadListingsCsv(backendUrl, { search, status, month });
        setNote(`Exported ${n ? n.toLocaleString() : 'all'} rows. Open the file in Excel.`);
      } else {
        const cols = columns;
        const lines = [cols.map((c) => csvEscape(c.label.replace(/ ↗/, ''))).join(',')];
        rows.forEach((r) => lines.push(cols.map((c) => csvEscape(cellValue(c, r))).join(',')));
        saveBlob(new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }), `${SHEETS[sheet].label.toLowerCase().replace(/ /g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`);
        setNote(`Exported ${rows.length.toLocaleString()} rows. Open the file in Excel.`);
      }
    } catch (e) {
      setNote('');
      setError(e.message);
    }
  }

  const sheetCount = (k) => (k === 'listings' ? listings.total : k === 'matches' ? matches?.length : customers?.length);
  const sel = selected && shownRows[selected.r] ? { col: columns[selected.c], row: shownRows[selected.r] } : null;

  const border = '1px solid var(--border-color, #d0d7de)';
  const ctl = { padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e0', fontSize: '12px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* toolbar */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', backgroundColor: 'var(--bg-card, #fff)', border, borderRadius: '8px', padding: '10px 14px' }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`🔍 Search ${SHEETS[sheet].label.toLowerCase()}…`} style={{ ...ctl, flex: 1, minWidth: '220px' }} />
        {(sheet === 'listings' || sheet === 'matches') && (
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={ctl} aria-label="Status">
            <option value="all">All statuses</option>
            {sheet === 'listings'
              ? [['for_sale', 'Active for sale'], ['under_contract', 'Under contract'], ['pending', 'Pending'], ['closed', 'Closed']].map(([v, l]) => <option key={v} value={v}>{l}</option>)
              : ['pending', 'contacted', 'dismissed', 'booked'].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        {sheet === 'listings' && (
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={ctl} aria-label="Month">
            <option value="all">All months</option>
            {months.map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}{m.total ? ` (${m.total.toLocaleString()})` : ''}</option>)}
          </select>
        )}
        <button type="button" onClick={exportCsv} style={{ ...ctl, backgroundColor: '#217346', color: '#fff', border: 'none', fontWeight: 700, cursor: 'pointer' }}>
          ⬇ Export to Excel (CSV)
        </button>
      </div>

      {/* formula bar */}
      <div style={{ display: 'flex', alignItems: 'stretch', border, borderRadius: '6px', backgroundColor: 'var(--bg-card, #fff)', fontSize: '12px', overflow: 'hidden' }}>
        <div style={{ width: '120px', flex: 'none', padding: '6px 10px', borderRight: border, backgroundColor: '#f3f4f6', fontWeight: 700, color: '#374151' }}>
          {sel ? `R${(sheet === 'listings' ? (page - 1) * PAGE : (page - 1) * PAGE) + selected.r + 1} · ${sel.col.label.replace(' ↗', '')}` : 'Select a cell'}
        </div>
        <div style={{ flex: 1, padding: '6px 10px', overflowX: 'auto', whiteSpace: 'nowrap' }}>{sel ? cellText(sel.col, sel.row) : ''}</div>
      </div>

      {error && <div style={{ color: '#c53030', fontSize: '12px' }}>⚠ {error}</div>}
      {note && <div style={{ color: '#276749', fontSize: '12px' }}>{note}</div>}

      {/* grid */}
      <div style={{ border, borderRadius: '6px', backgroundColor: 'var(--bg-card, #fff)', overflow: 'auto', maxHeight: '64vh', position: 'relative', opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: '12px', tableLayout: 'fixed', width: `${46 + columns.reduce((s, c) => s + c.w, 0)}px` }}>
          <colgroup>
            <col style={{ width: '46px' }} />
            {columns.map((c) => <col key={c.key} style={{ width: `${c.w}px` }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ position: 'sticky', top: 0, left: 0, zIndex: 3, backgroundColor: '#e5e7eb', borderRight: border, borderBottom: border }} />
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  title="Click to sort"
                  style={{ position: 'sticky', top: 0, zIndex: 2, backgroundColor: '#f3f4f6', color: '#111827', textAlign: c.num ? 'right' : 'left', padding: '7px 8px', borderRight: border, borderBottom: border, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {c.label}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((row, r) => (
              <tr key={row.id || r}>
                <td style={{ position: 'sticky', left: 0, zIndex: 1, backgroundColor: '#f3f4f6', color: '#6b7280', textAlign: 'center', borderRight: border, borderBottom: border, fontSize: '11px' }}>
                  {(page - 1) * PAGE + r + 1}
                </td>
                {columns.map((c, ci) => {
                  const text = cellText(c, row);
                  const isSel = selected && selected.r === r && selected.c === ci;
                  const linkable = c.link && text !== '' && text !== 0;
                  return (
                    <td
                      key={c.key}
                      onClick={() => setSelected({ r, c: ci })}
                      style={{
                        padding: '5px 8px', borderRight: border, borderBottom: border, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        textAlign: c.num ? 'right' : 'left', outline: isSel ? '2px solid #217346' : 'none', outlineOffset: '-2px',
                        backgroundColor: isSel ? '#e8f5ec' : 'transparent',
                      }}
                    >
                      {linkable ? (
                        <a href="#sheet" onClick={(e) => { e.preventDefault(); e.stopPropagation(); c.link(row); }} style={{ color: '#2b6cb0', textDecoration: 'underline' }}>{text}</a>
                      ) : text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!shownRows.length && (
              <tr><td colSpan={columns.length + 1} style={{ padding: '30px', textAlign: 'center', color: '#718096' }}>
                {loading || (sheet === 'matches' && matches === null) || (sheet === 'customers' && customers === null) ? 'Loading…' : 'No rows match.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* bottom: sheet tabs + pager */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', gap: '2px' }}>
          {Object.entries(SHEETS).map(([k, s]) => (
            <button
              key={k}
              type="button"
              onClick={() => { if (k !== sheet) jump(k, ''); }}
              style={{
                padding: '7px 16px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', borderRadius: '0 0 6px 6px',
                border, borderTop: sheet === k ? '3px solid #217346' : border,
                backgroundColor: sheet === k ? 'var(--bg-card, #fff)' : '#f3f4f6', color: sheet === k ? '#217346' : '#4b5563',
              }}
            >
              {s.label}{sheetCount(k) !== undefined && sheetCount(k) !== null ? ` (${sheetCount(k).toLocaleString()})` : ''}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#4a5568' }}>
          {sheet === 'listings' && sort && <span>Sorted within this page only</span>}
          <span>{total ? `${((page - 1) * PAGE + 1).toLocaleString()}–${Math.min(page * PAGE, total).toLocaleString()} of ${total.toLocaleString()}` : '0 rows'}</span>
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ ...ctl, cursor: page <= 1 ? 'default' : 'pointer' }}>‹ Prev</button>
          <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} style={{ ...ctl, cursor: page >= pages ? 'default' : 'pointer' }}>Next ›</button>
        </div>
      </div>
    </div>
  );
}
