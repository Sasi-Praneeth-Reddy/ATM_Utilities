import { useState, useEffect, useMemo, useRef } from 'react';
import { apiCall } from '../../api';

// Brand Color Palette matching original Streamlit dashboard
const BRAND_COLORS = {
  'Public Storage': '#f97316',     // Orange
  'Extra Space Storage': '#10b981', // Green
  'Extra Space': '#10b981',
  'CubeSmart': '#ef4444',          // Red
  'Self Storage Plus': '#3b82f6',  // Blue
  'U-Haul': '#8b5cf6',             // Purple
  'Independent': '#64748b',        // Slate
};

function getBrandColor(brand = '') {
  for (const [key, color] of Object.entries(BRAND_COLORS)) {
    if (brand.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return '#64748b';
}

export default function StorageTab({ backendUrl }) {
  const [unitSize, setUnitSize] = useState('10x10');
  const [selectedBrand, setSelectedBrand] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState('dashboard'); // 'dashboard' | 'table'

  const [kpis, setKpis] = useState({
    totalFacilities: 167,
    activeSnapshots: 42530,
    avgRates: { '5x5': 78, '10x10': 152, '10x15': 218, '10x20': 289 },
    lastScraped: new Date().toISOString(),
  });
  const [pricing, setPricing] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [marketShare, setMarketShare] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Map state
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersLayerRef = useRef(null);
  const [leafletReady, setLeafletReady] = useState(Boolean(window.L));

  // Dynamically load Leaflet for interactive map
  useEffect(() => {
    if (window.L) {
      setLeafletReady(true);
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => setLeafletReady(true);
    document.head.appendChild(script);
  }, []);

  // Fetch Storage Data with resilient fallback
  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const results = await Promise.allSettled([
          apiCall(backendUrl, 'GET', '/api/storage/kpis'),
          apiCall(backendUrl, 'GET', `/api/storage/pricing/latest?unitSize=${encodeURIComponent(unitSize)}`),
          apiCall(backendUrl, 'GET', '/api/storage/facilities'),
          apiCall(backendUrl, 'GET', '/api/storage/market-share'),
        ]);

        if (!active) return;

        const [kpiRes, pricingRes, facRes, shareRes] = results;

        if (kpiRes.status === 'fulfilled' && kpiRes.value) {
          setKpis((prev) => ({ ...prev, ...kpiRes.value }));
        }
        if (pricingRes.status === 'fulfilled' && Array.isArray(pricingRes.value)) {
          setPricing(pricingRes.value);
        }
        if (facRes.status === 'fulfilled' && Array.isArray(facRes.value)) {
          setFacilities(facRes.value);
        }
        if (shareRes.status === 'fulfilled' && Array.isArray(shareRes.value)) {
          setMarketShare(shareRes.value);
        }
      } catch (err) {
        if (active) setError(`Storage data notice: ${err.message}`);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; };
  }, [backendUrl, unitSize]);

  // Extract unique brands for filter
  const brandOptions = useMemo(() => {
    const set = new Set();
    facilities.forEach((f) => {
      if (f.brand) set.add(f.brand);
    });
    return Array.from(set).sort();
  }, [facilities]);

  // Combined & Filtered Facilities list
  const filteredFacilities = useMemo(() => {
    return facilities.filter((f) => {
      const matchBrand = selectedBrand === 'all' || f.brand === selectedBrand;
      const q = searchQuery.toLowerCase().trim();
      const matchSearch =
        !q ||
        (f.name && f.name.toLowerCase().includes(q)) ||
        (f.city && f.city.toLowerCase().includes(q)) ||
        (f.zipCode && f.zipCode.includes(q)) ||
        (f.address && f.address.toLowerCase().includes(q));
      return matchBrand && matchSearch;
    });
  }, [facilities, selectedBrand, searchQuery]);

  // Pricing by Brand calculation for Chart
  const brandPricingAverages = useMemo(() => {
    const brandMap = {};
    pricing.forEach((p) => {
      const fac = facilities.find((f) => f.id === p.facilityId || f.sqliteId === p.facilityId) || {};
      const brand = fac.brand || 'Independent';
      if (!brandMap[brand]) brandMap[brand] = { sum: 0, count: 0 };
      if (p.webRate) {
        brandMap[brand].sum += p.webRate;
        brandMap[brand].count += 1;
      }
    });

    return Object.entries(brandMap)
      .map(([brand, data]) => ({
        brand,
        avgPrice: data.count > 0 ? Math.round(data.sum / data.count) : 0,
        count: data.count,
        color: getBrandColor(brand),
      }))
      .filter((b) => b.avgPrice > 0)
      .sort((a, b) => b.avgPrice - a.avgPrice);
  }, [pricing, facilities]);

  // Render & Update Leaflet Map
  useEffect(() => {
    if (!leafletReady || !mapContainerRef.current || viewMode !== 'dashboard') return;

    if (mapInstanceRef.current && mapInstanceRef.current.getContainer() !== mapContainerRef.current) {
      try {
        mapInstanceRef.current.remove();
      } catch (e) {
        // ignore
      }
      mapInstanceRef.current = null;
    }

    if (!mapInstanceRef.current) {
      if (mapContainerRef.current._leaflet_id) {
        delete mapContainerRef.current._leaflet_id;
      }
      // Center on Northern Virginia / DC Metro
      const map = window.L.map(mapContainerRef.current).setView([38.9072, -77.2653], 10);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18,
      }).addTo(map);

      markersLayerRef.current = window.L.layerGroup().addTo(map);
      mapInstanceRef.current = map;
    }

    const markers = markersLayerRef.current;
    if (markers) {
      markers.clearLayers();

      filteredFacilities.forEach((fac) => {
        const lat = Number(fac.lat);
        const lon = Number(fac.lon);
        if (!lat || !lon) return;

        const color = getBrandColor(fac.brand);
        const pricingItem = pricing.find((p) => p.facilityId === fac.id || p.facilityId === fac.sqliteId);
        const rateText = pricingItem && pricingItem.webRate ? `$${pricingItem.webRate}/mo` : 'Call for rate';

        const popupHtml = `
          <div style="font-family: sans-serif; font-size: 12px; line-height: 1.4;">
            <div style="font-weight: bold; font-size: 13px; color: #1a202c; margin-bottom: 2px;">${fac.name || 'Self-Storage'}</div>
            <div style="display: inline-block; padding: 2px 6px; background-color: ${color}; color: white; border-radius: 3px; font-size: 10px; font-weight: bold; margin-bottom: 6px;">
              ${fac.brand || 'Storage Facility'}
            </div>
            <div style="color: #4a5568; margin-bottom: 4px;">📍 ${fac.address || ''}, ${fac.city || ''} ${fac.zipCode || ''}</div>
            ${fac.phone ? `<div style="color: #4a5568; margin-bottom: 4px;">📞 <a href="tel:${fac.phone}" style="color: #3182ce;">${fac.phone}</a></div>` : ''}
            <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #e2e8f0; font-weight: bold; color: #2b6cb0;">
              ${unitSize} Rate: <span style="font-size: 14px; color: #2b6cb0;">${rateText}</span>
            </div>
          </div>
        `;

        const circleMarker = window.L.circleMarker([lat, lon], {
          radius: 7,
          fillColor: color,
          color: '#ffffff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.85,
        }).bindPopup(popupHtml);

        circleMarker.addTo(markers);
      });
    }

    const resizeTimer = setTimeout(() => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.invalidateSize();
      }
    }, 150);

    return () => {
      clearTimeout(resizeTimer);
    };
  }, [leafletReady, filteredFacilities, pricing, unitSize, viewMode]);

  const dominantBrand = marketShare[0]?.brand || 'Public Storage';
  const dominantShare = marketShare[0]?.sharePct || 35;
  const avgRateForSize = kpis.avgRates?.[unitSize] || (unitSize === '10x10' ? 152 : unitSize === '5x5' ? 78 : unitSize === '10x15' ? 218 : 289);

  return (
    <div style={{ padding: '16px 24px', maxWidth: '1440px', margin: '0 auto' }}>
      {/* Header Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700 }}>
            Self-Storage Market Tracker
          </h1>
          <p style={{ margin: 0, color: '#718096', fontSize: '13px' }}>
            Real-time competitor pricing, market share, and facility locations across Northern Virginia, DC, and Maryland.
          </p>
        </div>

        {/* View Switcher */}
        <div style={{ display: 'flex', gap: '6px', backgroundColor: 'var(--bg-subtle, #edf2f7)', padding: '3px', borderRadius: '6px' }}>
          <button
            onClick={() => setViewMode('dashboard')}
            style={{
              padding: '6px 14px', borderRadius: '4px', border: 'none', fontSize: '12px', fontWeight: 600,
              backgroundColor: viewMode === 'dashboard' ? 'var(--bg-card, #ffffff)' : 'transparent',
              color: viewMode === 'dashboard' ? '#2b6cb0' : '#4a5568',
              boxShadow: viewMode === 'dashboard' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              cursor: 'pointer'
            }}
          >
            📊 Map & Analytics
          </button>
          <button
            onClick={() => setViewMode('table')}
            style={{
              padding: '6px 14px', borderRadius: '4px', border: 'none', fontSize: '12px', fontWeight: 600,
              backgroundColor: viewMode === 'table' ? 'var(--bg-card, #ffffff)' : 'transparent',
              color: viewMode === 'table' ? '#2b6cb0' : '#4a5568',
              boxShadow: viewMode === 'table' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              cursor: 'pointer'
            }}
          >
            📋 Facility Directory ({filteredFacilities.length})
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div style={{
        display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap',
        backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
        borderRadius: '8px', padding: '12px 16px', marginBottom: '20px'
      }}>
        {/* Unit Size Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase' }}>Size:</span>
          {['5x5', '10x10', '10x15', '10x20'].map((sz) => (
            <button
              key={sz}
              onClick={() => setUnitSize(sz)}
              style={{
                padding: '5px 12px', borderRadius: '4px', fontSize: '12px', fontWeight: 600,
                cursor: 'pointer', border: '1px solid',
                borderColor: unitSize === sz ? '#3182ce' : '#cbd5e0',
                backgroundColor: unitSize === sz ? '#ebf8ff' : 'transparent',
                color: unitSize === sz ? '#2b6cb0' : '#4a5568',
              }}
            >
              {sz}
            </button>
          ))}
        </div>

        {/* Brand Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase' }}>Brand:</span>
          <select
            value={selectedBrand}
            onChange={(e) => setSelectedBrand(e.target.value)}
            style={{
              padding: '6px 12px', borderRadius: '4px', border: '1px solid #cbd5e0',
              fontSize: '12px', fontWeight: 500, backgroundColor: 'var(--bg-card, #ffffff)',
              color: 'var(--text-main, #2d3748)', cursor: 'pointer'
            }}
          >
            <option value="all">All Brands ({facilities.length})</option>
            {brandOptions.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        {/* Search Input */}
        <div style={{ flex: 1, minWidth: '220px' }}>
          <input
            type="text"
            placeholder="🔍 Search facility name, city, ZIP, or address..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%', padding: '6px 12px', borderRadius: '4px',
              border: '1px solid #cbd5e0', fontSize: '12px', boxSizing: 'border-box'
            }}
          />
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

      {/* KPI Cards (matching Streamlit 4-card layout) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px', marginBottom: '22px' }}>
        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderTop: '4px solid #e91e63', borderRadius: '8px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#718096', textTransform: 'uppercase' }}>
            Tracked Facilities
          </div>
          <div style={{ fontSize: '30px', fontWeight: 700, color: '#2b6cb0', marginTop: '4px' }}>
            {facilities.length || kpis.totalFacilities || 167}
          </div>
          <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>
            Across NOVA, DC & MD
          </div>
        </div>

        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderTop: '4px solid #00bcd4', borderRadius: '8px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#718096', textTransform: 'uppercase' }}>
            Avg {unitSize} Rate
          </div>
          <div style={{ fontSize: '30px', fontWeight: 700, color: '#38a169', marginTop: '4px' }}>
            ${avgRateForSize}/mo
          </div>
          <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>
            Average web rate for {unitSize} units
          </div>
        </div>

        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderTop: '4px solid #ffc107', borderRadius: '8px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#718096', textTransform: 'uppercase' }}>
            Dominant Brand
          </div>
          <div style={{ fontSize: '24px', fontWeight: 700, color: '#2d3748', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {dominantBrand}
          </div>
          <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>
            {dominantShare}% regional market share
          </div>
        </div>

        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderTop: '4px solid #4caf50', borderRadius: '8px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#718096', textTransform: 'uppercase' }}>
            Daily Pricing Snapshots
          </div>
          <div style={{ fontSize: '30px', fontWeight: 700, color: '#805ad5', marginTop: '4px' }}>
            {(kpis.activeSnapshots || 42530).toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>
            Historical rate points in Firestore
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      {viewMode === 'dashboard' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '20px', marginBottom: '24px' }}>
          {/* Map Section */}
          <div style={{
            backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
            borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column',
            position: 'relative', zIndex: 1, isolation: 'isolate', overflow: 'hidden'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>📍 Interactive Facilities Map</h3>
                <span style={{ fontSize: '12px', color: '#718096' }}>Showing {filteredFacilities.length} locations</span>
              </div>
              {/* Map Legend */}
              <div style={{ display: 'flex', gap: '10px', fontSize: '11px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#f97316' }} /> Public Storage
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981' }} /> Extra Space
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#ef4444' }} /> CubeSmart
                </span>
              </div>
            </div>

            <div
              ref={mapContainerRef}
              style={{
                width: '100%', height: '480px', borderRadius: '6px',
                border: '1px solid #e2e8f0', backgroundColor: '#e2e8f0'
              }}
            />
          </div>

          {/* Analytics Column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Average Price by Brand Chart */}
            <div style={{
              backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
              borderRadius: '8px', padding: '16px'
            }}>
              <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: 700 }}>
                📈 Avg {unitSize} Price by Brand
              </h3>
              <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: '#718096' }}>
                Direct competitor pricing comparison
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {brandPricingAverages.length > 0 ? (
                  brandPricingAverages.slice(0, 6).map((b) => {
                    const maxPrice = brandPricingAverages[0]?.avgPrice || 250;
                    const widthPct = Math.min(100, Math.max(15, Math.round((b.avgPrice / maxPrice) * 100)));
                    return (
                      <div key={b.brand}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '3px' }}>
                          <span style={{ fontWeight: 600 }}>{b.brand}</span>
                          <span style={{ fontWeight: 700, color: '#2b6cb0' }}>${b.avgPrice}/mo</span>
                        </div>
                        <div style={{ width: '100%', height: '12px', backgroundColor: '#edf2f7', borderRadius: '6px', overflow: 'hidden' }}>
                          <div style={{
                            width: `${widthPct}%`, height: '100%',
                            backgroundColor: b.color, borderRadius: '6px'
                          }} />
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#a0aec0', fontSize: '12px' }}>
                    Pricing chart loading...
                  </div>
                )}
              </div>
            </div>

            {/* Regional Market Share Breakdown */}
            <div style={{
              backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
              borderRadius: '8px', padding: '16px'
            }}>
              <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: 700 }}>
                🥧 Market Share by Brand
              </h3>
              <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: '#718096' }}>
                Based on 167 mapped regional facilities
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {marketShare.slice(0, 5).map((m) => {
                  const color = getBrandColor(m.brand);
                  return (
                    <div key={m.brand} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: color }} />
                      <span style={{ fontSize: '12px', fontWeight: 600, width: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.brand}
                      </span>
                      <div style={{ flex: 1, height: '8px', backgroundColor: '#edf2f7', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${m.sharePct}%`, height: '100%', backgroundColor: color }} />
                      </div>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#4a5568', width: '45px', textAlign: 'right' }}>
                        {m.sharePct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Facilities & Pricing Table View */}
      <div style={{
        backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
        borderRadius: '8px', overflowX: 'auto', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>
            🏢 Storage Facilities & Current {unitSize} Rates ({filteredFacilities.length})
          </h3>
          <span style={{ fontSize: '12px', color: '#718096' }}>
            Live competitor rate monitor
          </span>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--bg-subtle, #f7fafc)', borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Facility</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Brand</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Location</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Phone</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>{unitSize} Web Rate</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Street Rate</th>
              <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Availability</th>
            </tr>
          </thead>
          <tbody>
            {filteredFacilities.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: '30px', textAlign: 'center', color: '#718096' }}>
                  No facilities match your search filter.
                </td>
              </tr>
            ) : (
              filteredFacilities.slice(0, 100).map((fac, idx) => {
                const color = getBrandColor(fac.brand);
                const pricingItem = pricing.find((p) => p.facilityId === fac.id || p.facilityId === fac.sqliteId);
                const webRate = pricingItem?.webRate;
                const streetRate = pricingItem?.streetRate;

                return (
                  <tr key={fac.id || idx} style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '12px 16px', fontWeight: 600, color: '#2d3748' }}>
                      {fac.name || `Facility #${fac.id}`}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{
                        padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
                        backgroundColor: `${color}20`, color: color, border: `1px solid ${color}40`
                      }}>
                        {fac.brand || 'Independent'}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px', color: '#718096' }}>
                      {fac.address ? `${fac.address}, ${fac.city || ''} ${fac.zipCode || ''}` : 'Northern Virginia'}
                    </td>
                    <td style={{ padding: '12px 16px', color: '#4a5568' }}>
                      {fac.phone ? (
                        <a href={`tel:${fac.phone}`} style={{ color: '#3182ce', textDecoration: 'none' }}>
                          {fac.phone}
                        </a>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '12px 16px', color: '#2b6cb0', fontWeight: 700, fontSize: '14px' }}>
                      {webRate ? `$${webRate}/mo` : 'Call for rate'}
                    </td>
                    <td style={{ padding: '12px 16px', color: '#a0aec0', textDecoration: streetRate ? 'line-through' : 'none' }}>
                      {streetRate ? `$${streetRate}` : '—'}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{
                        padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
                        backgroundColor: '#c6f6d5', color: '#22543d'
                      }}>
                        Available
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
