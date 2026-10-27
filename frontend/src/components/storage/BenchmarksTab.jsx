import { useState, useEffect } from 'react';
import { apiCall } from '../../api';

export default function BenchmarksTab({ backendUrl }) {
  const [source, setSource] = useState('NVAR');
  const [benchmarks, setBenchmarks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        setError('');
        const res = await apiCall(backendUrl, 'GET', `/api/storage/benchmarks?source=${encodeURIComponent(source)}`);
        if (active) setBenchmarks(res || []);
      } catch (err) {
        if (active) setError(`Failed to load benchmarks: ${err.message}`);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; };
  }, [backendUrl, source]);

  const latest = benchmarks[0] || {};

  return (
    <div style={{ padding: '16px 24px', maxWidth: '1440px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700 }}>
            Real Estate Market Benchmarks
          </h1>
          <p style={{ margin: 0, color: '#718096', fontSize: '13px' }}>
            Official historical housing market comparisons from NVAR and Bright MLS.
          </p>
        </div>

        {/* Source Switcher */}
        <div style={{ display: 'flex', gap: '8px' }}>
          {['NVAR', 'Bright MLS'].map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              style={{
                padding: '6px 14px', borderRadius: '4px', fontSize: '12px', fontWeight: 600,
                cursor: 'pointer', border: '1px solid',
                borderColor: source === s ? '#3182ce' : '#cbd5e0',
                backgroundColor: source === s ? '#ebf8ff' : 'var(--bg-card, #ffffff)',
                color: source === s ? '#2b6cb0' : '#4a5568',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{
          backgroundColor: '#fff5f5', color: '#c53030', border: '1px solid #feb2b2',
          padding: '10px 14px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px'
        }}>
          {error}
        </div>
      )}

      {/* Latest Month KPIs */}
      {latest.periodDate && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', marginBottom: '22px' }}>
          <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', padding: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#718096', textTransform: 'uppercase' }}>Period</div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#2b6cb0', marginTop: '4px' }}>
              {latest.periodDate}
            </div>
            <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>{latest.region}</div>
          </div>

          <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', padding: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#718096', textTransform: 'uppercase' }}>Closed Sales</div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#38a169', marginTop: '4px' }}>
              {latest.closedSales ? Number(latest.closedSales).toLocaleString() : '—'}
            </div>
            <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>New listings: {latest.newListings || 0}</div>
          </div>

          <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', padding: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#718096', textTransform: 'uppercase' }}>Median Close Price</div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#2d3748', marginTop: '4px' }}>
              {latest.medianClosePrice ? `$${Number(latest.medianClosePrice).toLocaleString()}` : '—'}
            </div>
            <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>Avg: ${Number(latest.avgClosePrice || 0).toLocaleString()}</div>
          </div>

          <div style={{ backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', padding: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#718096', textTransform: 'uppercase' }}>Days on Market</div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#e53e3e', marginTop: '4px' }}>
              {latest.medianDaysOnMarket ? `${latest.medianDaysOnMarket} days` : '—'}
            </div>
            <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>Close-to-list: {latest.closeToListRatio}%</div>
          </div>
        </div>
      )}

      {/* History Table */}
      <div style={{
        backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
        borderRadius: '8px', overflowX: 'auto', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--bg-subtle, #f7fafc)', borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Period</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Region</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Closed Sales</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>New Listings</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Median Days</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Median Price</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Close / List</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: '30px', textAlign: 'center', color: '#718096' }}>Loading benchmarks...</td></tr>
            ) : benchmarks.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: '30px', textAlign: 'center', color: '#718096' }}>No benchmark records found. Run migration script to populate data.</td></tr>
            ) : (
              benchmarks.map((b, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600 }}>{b.periodDate}</td>
                  <td style={{ padding: '12px 16px', color: '#718096' }}>{b.region}</td>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#38a169' }}>
                    {b.closedSales ? Number(b.closedSales).toLocaleString() : '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>{b.newListings ? Number(b.newListings).toLocaleString() : '—'}</td>
                  <td style={{ padding: '12px 16px' }}>{b.medianDaysOnMarket || '—'}</td>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#2b6cb0' }}>
                    {b.medianClosePrice ? `$${Number(b.medianClosePrice).toLocaleString()}` : '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>{b.closeToListRatio ? `${b.closeToListRatio}%` : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
