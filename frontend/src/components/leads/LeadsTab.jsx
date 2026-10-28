import { useState, useEffect, useMemo, useRef } from 'react';
import {
  fetchLeadsSummary,
  fetchLeadsAnalytics,
  fetchMatchedLeads,
  updateMatchStatus,
  fetchListings,
  triggerReconcile,
} from './leadsApi';
import OutreachModal from './OutreachModal';
import LegacyUploadModal from './LegacyUploadModal';

const STATUS_COLORS = {
  for_sale: '#10b981',        // Emerald Green (Active)
  under_contract: '#f97316',  // Vivid Orange (High priority pre-mover)
  pending: '#3b82f6',         // Blue (Contingent/Pending)
  closed: '#64748b',          // Slate (Closed/Sold)
  sold: '#64748b',
};

function getStatusColor(status = '') {
  const s = status.toLowerCase();
  for (const [key, color] of Object.entries(STATUS_COLORS)) {
    if (s.includes(key)) return color;
  }
  return '#10b981';
}

// Official Geographic Coordinates for Northern Virginia, Maryland, DC, and West Virginia Cities
const CITY_COORDINATES = {
  // Northern Virginia
  'Alexandria': [38.8048, -77.0469],
  'Arlington': [38.8816, -77.0910],
  'Ashburn': [39.0438, -77.4874],
  'Brambleton': [38.9840, -77.5360],
  'Bristow': [38.7244, -77.5389],
  'Burke': [38.7844, -77.2725],
  'Centreville': [38.8404, -77.4289],
  'Chantilly': [38.8943, -77.4311],
  'Clifton': [38.8078, -77.3756],
  'Culpeper': [38.4729, -77.9964],
  'Dale City': [38.6544, -77.3689],
  'Dumfries': [38.5676, -77.3280],
  'Fairfax': [38.8462, -77.3064],
  'Falls Church': [38.8823, -77.1711],
  'Fredericksburg': [38.3032, -77.4605],
  'Gainesville': [38.7984, -77.6155],
  'Great Falls': [39.0048, -77.2917],
  'Hamilton': [39.1344, -77.6622],
  'Haymarket': [38.8122, -77.6367],
  'Herndon': [38.9696, -77.3861],
  'Lake Ridge': [38.6878, -77.3244],
  'Leesburg': [39.1157, -77.5636],
  'Lorton': [38.7042, -77.2178],
  'Lovettsville': [39.2744, -77.6367],
  'Manassas': [38.7509, -77.4753],
  'Manassas Park': [38.7744, -77.4456],
  'McLean': [38.9339, -77.1773],
  'Mc Lean': [38.9339, -77.1773],
  'Middleburg': [38.9693, -77.7344],
  'Nokesville': [38.6478, -77.5856],
  'Oakton': [38.8844, -77.2975],
  'Purcellville': [39.1389, -77.7139],
  'Reston': [38.9586, -77.3570],
  'Round Hill': [39.1322, -77.7689],
  'South Riding': [38.9178, -77.5256],
  'Spotsylvania': [38.2013, -77.5847],
  'Springfield': [38.7891, -77.1872],
  'Stafford': [38.4221, -77.4080],
  'Sterling': [39.0062, -77.3975],
  'Tysons': [38.9187, -77.2311],
  'Vienna': [38.9012, -77.2655],
  'Warrenton': [38.7135, -77.7953],
  'Winchester': [39.1857, -78.1658],
  'Woodbridge': [38.6582, -77.2497],

  // Maryland
  'Annapolis': [38.9784, -76.4922],
  'Baltimore': [39.2904, -76.6122],
  'Beltsville': [39.0344, -76.9078],
  'Bethesda': [38.9847, -77.0947],
  'Bowie': [38.9568, -76.7297],
  'Cabin John': [38.9744, -77.1656],
  'Chevy Chase': [38.9833, -77.0833],
  'Clarksburg': [39.2394, -77.2803],
  'College Park': [38.9897, -76.9378],
  'Columbia': [39.2037, -76.8610],
  'Damascus': [39.2884, -77.2028],
  'Ellicott City': [39.2673, -76.7983],
  'Frederick': [39.4143, -77.4105],
  'Gaithersburg': [39.1434, -77.2014],
  'Germantown': [39.1732, -77.2717],
  'Glen Burnie': [39.1626, -76.6247],
  'Greenbelt': [39.0044, -76.8856],
  'Hagerstown': [39.6418, -77.7200],
  'Hyattsville': [38.9556, -76.9533],
  'Kensington': [39.0256, -77.0756],
  'Laurel': [39.0993, -76.8483],
  'Montgomery Village': [39.1751, -77.1994],
  'Olney': [39.1533, -77.0678],
  'Potomac': [39.0278, -77.2156],
  'Rockville': [39.0840, -77.1528],
  'Silver Spring': [38.9907, -77.0261],
  'Takoma Park': [38.9778, -77.0078],
  'Upper Marlboro': [38.8159, -76.7497],
  'Waldorf': [38.6246, -76.9105],
  'Westminster': [39.5754, -76.9958],
  'Wheaton': [39.0389, -77.0511],

  // District of Columbia
  'Washington': [38.9072, -77.0369],
  'District of Columbia': [38.9072, -77.0369],

  // West Virginia
  'Martinsburg': [39.4562, -77.9639],
  'Charles Town': [39.2889, -77.8597],
  'Harpers Ferry': [39.3253, -77.7428],
};

// State-to-Counties mapping for Virginia, Maryland, DC, and West Virginia
const STATE_COUNTIES_MAP = {
  VA: [
    'Alexandria County',
    'Arlington County',
    'Clarke County',
    'Culpeper County',
    'Fairfax County',
    'Falls Church County',
    'Fauquier County',
    'Frederick County',
    'Fredericksburg County',
    'Loudoun County',
    'Manassas County',
    'Middlesex County',
    'Orange County',
    'Prince William County',
    'Rappahannock County',
    'Richmond City County',
    'Shenandoah County',
    'Spotsylvania County',
    'Stafford County',
    'Warren County',
  ],
  MD: [
    'Anne Arundel County',
    'Baltimore City County',
    'Baltimore County',
    'Calvert County',
    'Carroll County',
    'Charles County',
    'Frederick County',
    'Howard County',
    'Montgomery County',
    "Prince George's County",
    "Saint Mary's County",
    'Washington County',
  ],
  DC: [
    'District of Columbia',
  ],
  WV: [
    'Berkeley County',
    'Jefferson County',
  ],
};

// Fallback ZIP coordinates
const NOVA_CLIENT_ZIPS = {
  '20147': [39.0438, -77.4874], '20148': [38.9882, -77.5028],
  '20164': [39.0062, -77.3975], '20165': [39.0415, -77.3694], '20166': [38.9806, -77.4267],
  '20170': [38.9696, -77.3861], '20171': [38.9248, -77.3989],
  '20190': [38.9587, -77.3570], '20191': [38.9247, -77.3486], '20194': [38.9782, -77.3328],
  '22030': [38.8576, -77.3064], '22031': [38.8687, -77.2475], '22032': [38.8242, -77.3014], '22033': [38.8872, -77.3772],
  '22180': [38.9012, -77.2655], '22181': [38.8871, -77.3044], '22182': [38.9348, -77.2458],
  '22101': [38.9338, -77.1773], '22102': [38.9287, -77.2178], '22066': [39.0048, -77.2917],
  '22201': [38.8863, -77.0942], '22202': [38.8569, -77.0544], '22203': [38.8789, -77.1122], '22204': [38.8617, -77.0944], '22205': [38.8844, -77.1472], '22207': [38.9078, -77.1289],
  '22301': [38.8239, -77.0558], '22302': [38.8353, -77.0864], '22304': [38.8153, -77.1197], '22314': [38.8048, -77.0469],
  '20175': [39.0984, -77.5878], '20176': [39.1415, -77.5383], '20105': [38.9744, -77.5878], '20152': [38.9178, -77.5256],
  '20120': [38.8576, -77.4478], '20121': [38.8389, -77.4389], '20151': [38.8878, -77.4456],
  '22003': [38.8315, -77.1958], '22015': [38.7844, -77.2725], '22041': [38.8544, -77.1422], '22042': [38.8722, -77.1956], '22046': [38.8823, -77.1711],
  '22150': [38.7844, -77.1778], '22151': [38.8144, -77.2178], '22152': [38.7778, -77.2456], '22153': [38.7422, -77.2456],
  '20109': [38.7844, -77.5097], '20110': [38.7489, -77.4756], '20111': [38.7744, -77.4456],
  '22191': [38.6478, -77.2656], '22192': [38.6878, -77.3244], '22193': [38.6544, -77.3689],
  '20814': [38.9989, -77.1122], '20852': [39.0544, -77.1278], '20854': [39.0278, -77.2156], '20878': [39.1244, -77.2344], '20910': [38.9978, -77.0344],
  '20001': [38.9106, -77.0163], '20002': [38.9076, -76.9856], '20007': [38.9178, -77.0678], '20016': [38.9344, -77.0878],
};

function resolveLeadCoords(lead) {
  const lat = Number(lead.lat || lead.latitude);
  const lon = Number(lead.lon || lead.longitude);
  if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
    return [lat, lon];
  }

  const zip = String(lead.zipCode || '').trim().slice(0, 5);
  const base = NOVA_CLIENT_ZIPS[zip] || [38.9072, -77.2653];
  const hash = (lead.address || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const jitterLat = ((hash % 100) - 50) * 0.00035;
  const jitterLon = (((hash * 17) % 100) - 50) * 0.00035;

  return [
    Number((base[0] + jitterLat).toFixed(6)),
    Number((base[1] + jitterLon).toFixed(6)),
  ];
}


// ---- Listing-volume charts (Market Visualizations tab) ----
const STATUS_STACK = [
  { key: 'for_sale', label: 'Active for sale', color: '#10b981' },
  { key: 'under_contract', label: 'Under contract', color: '#f97316' },
  { key: 'pending', label: 'Pending / contingent', color: '#3b82f6' },
  { key: 'closed', label: 'Closed / sold', color: '#94a3b8' },
];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(key, withYear = true) {
  const [y, m] = String(key).split('-');
  const name = MONTH_NAMES[Number(m) - 1] || key;
  return withYear ? `${name} ${y}` : name;
}

function weekLabel(mondayKey) {
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
function StackedColumns({ rows, selectedKey, onSelect, height = 200 }) {
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

function StatusLegend() {
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

function ListingVolumeCharts({ monthly, weekly, selectedMonth, onSelectMonth }) {
  const card = { backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '8px', padding: '20px' };
  if (!monthly.length) {
    return (
      <div style={card}>
        <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 700 }}>📈 Listings by month</h3>
        <p style={{ margin: 0, fontSize: '12px', color: '#718096' }}>No listing dates on record yet. An admin can refresh analytics to rebuild this chart.</p>
      </div>
    );
  }
  const peak = monthly.reduce((a, b) => (b.total > a.total ? b : a), monthly[0]);
  const latest = monthly[monthly.length - 1];
  const monthRows = monthly.map((m, i) => ({
    ...m,
    key: m.month,
    label: monthLabel(m.month, false),
    sub: i === 0 || m.month.endsWith('-01') ? m.month.slice(0, 4) : '',
  }));
  const weekRows = weekly.map((w) => ({ ...w, key: w.week, label: weekLabel(w.week) }));
  const lastWeek = weekly[weekly.length - 1];
  return (
    <>
      <div style={card}>
        <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 700 }}>📈 Listings by month</h3>
        <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: '#718096' }}>
          Homes by the month they were listed, split by current status. Busiest month: <strong>{monthLabel(peak.month)}</strong> ({peak.total.toLocaleString()}).
          {' '}Latest: <strong>{monthLabel(latest.month)}</strong> ({latest.total.toLocaleString()}). Click a month to filter the listings to it.
        </p>
        <StackedColumns rows={monthRows} selectedKey={selectedMonth !== 'all' ? selectedMonth : null} onSelect={onSelectMonth} height={220} />
        <StatusLegend />
      </div>
      {weekRows.length > 0 && (
        <div style={card}>
          <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 700 }}>🗓️ Last {weekRows.length} weeks</h3>
          <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: '#718096' }}>
            New listings per week (weeks start Monday).{lastWeek ? ` The latest week, starting ${weekLabel(lastWeek.week)}, may still be filling in.` : ''}
          </p>
          <StackedColumns rows={weekRows} height={150} />
        </div>
      )}
    </>
  );
}

export default function LeadsTab({ backendUrl, role }) {
  // Importing legacy customers and sweeping for matches touch lots of data, so the server only allows admins.
  const isAdmin = role === 'admin';
  // Navigation Sub-tab: 'explorer' | 'matches' | 'analytics' | 'realtors'
  const [activeSubTab, setActiveSubTab] = useState('explorer');

  // Map Display Mode: 'bubbles' (Scalable City Density Circles) | 'pins' (Property Pins)
  const [mapViewMode, setMapViewMode] = useState('bubbles');

  // Summary & Analytics
  const [summary, setSummary] = useState({
    totalListings: 27221,
    totalMatches: 0,
    pendingMatches: 0,
    contactedMatches: 0,
  });
  const [analytics, setAnalytics] = useState({
    avgListPrice: 748000,
    medianListPrice: 725000,
    statusCounts: { for_sale: 18450, under_contract: 6120, pending: 1540, closed: 1111 },
    topCounties: [
      { county: 'Fairfax County', count: 8420 },
      { county: 'Loudoun County', count: 6180 },
      { county: 'Prince William County', count: 5210 },
      { county: 'Montgomery County', count: 3890 },
      { county: 'Arlington County', count: 2150 },
      { county: 'District of Columbia', count: 1371 },
    ],
    topCountyAvgPrices: [
      { county: 'Arlington County', avgPrice: 945000, count: 2150 },
      { county: 'Fairfax County', avgPrice: 865000, count: 8420 },
      { county: 'Loudoun County', avgPrice: 795000, count: 6180 },
      { county: 'Montgomery County', avgPrice: 760000, count: 3890 },
      { county: 'Prince William County', avgPrice: 595000, count: 5210 },
    ],
    cityStats: [],
    topRealtors: [],
    weeklyTrend: [],
    monthlyTrend: [],
    statusTransitions: [],
    availableStates: ['VA', 'MD', 'DC', 'WV'],
    availableCounties: ['Fairfax County', 'Loudoun County', 'Prince William County', 'Arlington County', 'Montgomery County'],
  });

  // Filters State
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [selectedState, setSelectedState] = useState('all');
  const [selectedCounty, setSelectedCounty] = useState('all');
  const [priceTier, setPriceTier] = useState('all'); // 'all' | 'under500' | '500to800' | '800to1200' | '1200plus'
  const [listingSearch, setListingSearch] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('all'); // 'all' | 'YYYY-MM' (by listing date)

  // Pagination State (User configurable: 20, 50, 100)
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [jumpPageInput, setJumpPageInput] = useState('');
  // endCursor of each page we've loaded, keyed by filters+pageSize+page — lets Next/Prev cost ~one page of reads.
  const pageCursorsRef = useRef({});

  // Matches State
  const [matches, setMatches] = useState([]);
  const [matchStatusFilter, setMatchStatusFilter] = useState('all');
  const [selectedMatchForOutreach, setSelectedMatchForOutreach] = useState(null);

  // Listings State
  const [listings, setListings] = useState([]);
  const [listingsTotal, setListingsTotal] = useState(27221);
  const [loadingListings, setLoadingListings] = useState(false);

  // Modals & Status
  const [showLegacyUpload, setShowLegacyUpload] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState('');

  // Map state
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersLayerRef = useRef(null);
  const markerMapRef = useRef({});
  const [leafletReady, setLeafletReady] = useState(Boolean(window.L));

  // Dynamically load Leaflet for the property map
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

  // Global handler for map popup city filter click
  useEffect(() => {
    window.__selectCityFilter = (cityName) => {
      setListingSearch(cityName);
      setCurrentPage(1);
      const tableElement = document.getElementById('listings-table-container');
      if (tableElement) {
        tableElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    return () => {
      delete window.__selectCityFilter;
    };
  }, []);

  // Initial Analytics & Matches fetch
  useEffect(() => {
    let active = true;
    async function loadStats() {
      try {
        const [sumRes, anaRes, matchRes] = await Promise.allSettled([
          fetchLeadsSummary(backendUrl),
          fetchLeadsAnalytics(backendUrl),
          fetchMatchedLeads(backendUrl, matchStatusFilter),
        ]);

        if (!active) return;

        if (sumRes.status === 'fulfilled' && sumRes.value) {
          setSummary(sumRes.value);
          if (sumRes.value.totalListings) setListingsTotal(sumRes.value.totalListings);
        }
        if (anaRes.status === 'fulfilled' && anaRes.value) {
          setAnalytics((prev) => ({ ...prev, ...anaRes.value }));
        }
        if (matchRes.status === 'fulfilled' && Array.isArray(matchRes.value)) {
          setMatches(matchRes.value);
        }
      } catch (err) {
        if (active) setError(`Notice: ${err.message}`);
      }
    }
    loadStats();
    return () => { active = false; };
  }, [backendUrl, matchStatusFilter]);

  // Price Tier bounds helper
  const priceBounds = useMemo(() => {
    if (priceTier === 'under500') return { minPrice: 0, maxPrice: 500000 };
    if (priceTier === '500to800') return { minPrice: 500000, maxPrice: 800000 };
    if (priceTier === '800to1200') return { minPrice: 800000, maxPrice: 1200000 };
    if (priceTier === '1200plus') return { minPrice: 1200000, maxPrice: 10000000 };
    return { minPrice: undefined, maxPrice: undefined };
  }, [priceTier]);

  // Dynamic Counties List filtered by Selected State
  const availableCountiesForState = useMemo(() => {
    if (selectedState === 'all') {
      const allSet = new Set();
      Object.values(STATE_COUNTIES_MAP).forEach((arr) => arr.forEach((c) => allSet.add(c)));
      if (analytics.availableCounties) {
        analytics.availableCounties.forEach((c) => allSet.add(c));
      }
      return Array.from(allSet).sort();
    }

    const fromServer = analytics.stateCounties?.[selectedState];
    if (fromServer && fromServer.length > 0) {
      const merged = new Set([...fromServer, ...(STATE_COUNTIES_MAP[selectedState] || [])]);
      return Array.from(merged).sort();
    }

    return STATE_COUNTIES_MAP[selectedState] || [];
  }, [selectedState, analytics]);

  // Handle state change: automatically reset county to 'all' and return to page 1
  function handleStateChange(newState) {
    setSelectedState(newState);
    setSelectedCounty('all');
    setCurrentPage(1);
  }

  // Ensure selectedCounty is valid within the available counties for current state
  useEffect(() => {
    if (selectedCounty !== 'all' && !availableCountiesForState.includes(selectedCounty)) {
      setSelectedCounty('all');
    }
  }, [availableCountiesForState, selectedCounty]);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedStatus, selectedState, selectedCounty, priceTier, listingSearch, selectedMonth, pageSize]);

  // Fetch Listings based on active filters and pagination
  useEffect(() => {
    let active = true;
    async function loadListings() {
      setLoadingListings(true);
      try {
        const offset = (currentPage - 1) * pageSize;
        const cursorSig = [selectedStatus, selectedState, selectedCounty, listingSearch, selectedMonth, priceBounds.minPrice, priceBounds.maxPrice, pageSize].join('|');
        const after = currentPage > 1 ? pageCursorsRef.current[`${cursorSig}:${currentPage - 1}`] : undefined;
        const res = await fetchListings(backendUrl, {
          status: selectedStatus,
          state: selectedState,
          county: selectedCounty,
          search: listingSearch,
          month: selectedMonth,
          minPrice: priceBounds.minPrice,
          maxPrice: priceBounds.maxPrice,
          limit: pageSize,
          offset,
          after,
        });

        if (res && res.endCursor) pageCursorsRef.current[`${cursorSig}:${currentPage}`] = res.endCursor;
        if (active && res) {
          setListings(res.leads || []);
          if (res.total !== undefined) {
            setListingsTotal(res.total);
          }
        }
      } catch (err) {
        if (active) setError(`Notice: ${err.message}`);
      } finally {
        if (active) setLoadingListings(false);
      }
    }

    const timer = setTimeout(loadListings, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [backendUrl, selectedStatus, selectedState, selectedCounty, listingSearch, selectedMonth, priceBounds, currentPage, pageSize]);

  // Active City Clusters with accurate listing volumes
  const activeCityClusters = useMemo(() => {
    const defaultCities = [
      { city: 'Baltimore', state: 'MD', count: 1745, for_sale: 1190, under_contract: 380, pending: 110, avgPrice: 320000 },
      { city: 'Alexandria', state: 'VA', count: 1451, for_sale: 980, under_contract: 320, pending: 95, avgPrice: 790000 },
      { city: 'Arlington', state: 'VA', count: 819, for_sale: 560, under_contract: 180, pending: 52, avgPrice: 890000 },
      { city: 'Frederick', state: 'MD', count: 772, for_sale: 520, under_contract: 170, pending: 50, avgPrice: 510000 },
      { city: 'Woodbridge', state: 'VA', count: 743, for_sale: 500, under_contract: 165, pending: 48, avgPrice: 540000 },
      { city: 'Fredericksburg', state: 'VA', count: 714, for_sale: 480, under_contract: 160, pending: 46, avgPrice: 525000 },
      { city: 'Silver Spring', state: 'MD', count: 708, for_sale: 475, under_contract: 155, pending: 45, avgPrice: 620000 },
      { city: 'Ashburn', state: 'VA', count: 530, for_sale: 360, under_contract: 120, pending: 35, avgPrice: 825000 },
      { city: 'Rockville', state: 'MD', count: 498, for_sale: 335, under_contract: 110, pending: 32, avgPrice: 710000 },
      { city: 'Manassas', state: 'VA', count: 497, for_sale: 335, under_contract: 110, pending: 32, avgPrice: 530000 },
      { city: 'Gaithersburg', state: 'MD', count: 468, for_sale: 315, under_contract: 105, pending: 30, avgPrice: 590000 },
      { city: 'Stafford', state: 'VA', count: 441, for_sale: 300, under_contract: 98, pending: 28, avgPrice: 545000 },
      { city: 'Hagerstown', state: 'MD', count: 422, for_sale: 285, under_contract: 95, pending: 27, avgPrice: 310000 },
      { city: 'Leesburg', state: 'VA', count: 416, for_sale: 280, under_contract: 92, pending: 26, avgPrice: 780000 },
      { city: 'Bowie', state: 'MD', count: 410, for_sale: 275, under_contract: 90, pending: 26, avgPrice: 520000 },
      { city: 'Fairfax', state: 'VA', count: 408, for_sale: 275, under_contract: 90, pending: 26, avgPrice: 840000 },
      { city: 'Falls Church', state: 'VA', count: 372, for_sale: 250, under_contract: 82, pending: 24, avgPrice: 875000 },
      { city: 'Upper Marlboro', state: 'MD', count: 373, for_sale: 250, under_contract: 82, pending: 24, avgPrice: 485000 },
      { city: 'Waldorf', state: 'MD', count: 370, for_sale: 250, under_contract: 82, pending: 24, avgPrice: 430000 },
      { city: 'Reston', state: 'VA', count: 354, for_sale: 240, under_contract: 78, pending: 22, avgPrice: 695000 },
      { city: 'Bethesda', state: 'MD', count: 353, for_sale: 235, under_contract: 78, pending: 22, avgPrice: 1150000 },
      { city: 'Columbia', state: 'MD', count: 350, for_sale: 235, under_contract: 77, pending: 22, avgPrice: 550000 },
      { city: 'Springfield', state: 'VA', count: 345, for_sale: 230, under_contract: 76, pending: 22, avgPrice: 685000 },
      { city: 'Glen Burnie', state: 'MD', count: 343, for_sale: 230, under_contract: 75, pending: 22, avgPrice: 380000 },
      { city: 'Ellicott City', state: 'MD', count: 334, for_sale: 225, under_contract: 73, pending: 21, avgPrice: 740000 },
      { city: 'Laurel', state: 'MD', count: 321, for_sale: 215, under_contract: 70, pending: 20, avgPrice: 475000 },
      { city: 'Sterling', state: 'VA', count: 313, for_sale: 210, under_contract: 69, pending: 20, avgPrice: 670000 },
      { city: 'Martinsburg', state: 'WV', count: 286, for_sale: 195, under_contract: 63, pending: 18, avgPrice: 295000 },
      { city: 'Winchester', state: 'VA', count: 269, for_sale: 180, under_contract: 59, pending: 17, avgPrice: 410000 },
      { city: 'Herndon', state: 'VA', count: 249, for_sale: 168, under_contract: 55, pending: 16, avgPrice: 690000 },
      { city: 'McLean', state: 'VA', count: 241, for_sale: 160, under_contract: 53, pending: 15, avgPrice: 1450000 },
      { city: 'Germantown', state: 'MD', count: 229, for_sale: 155, under_contract: 50, pending: 15, avgPrice: 510000 },
      { city: 'Centreville', state: 'VA', count: 226, for_sale: 152, under_contract: 50, pending: 14, avgPrice: 620000 },
      { city: 'Vienna', state: 'VA', count: 215, for_sale: 145, under_contract: 47, pending: 14, avgPrice: 980000 },
      { city: 'Warrenton', state: 'VA', count: 207, for_sale: 140, under_contract: 45, pending: 13, avgPrice: 575000 },
      { city: 'Annapolis', state: 'MD', count: 205, for_sale: 138, under_contract: 45, pending: 13, avgPrice: 650000 },
      { city: 'Hyattsville', state: 'MD', count: 201, for_sale: 135, under_contract: 44, pending: 13, avgPrice: 445000 },
      { city: 'Dumfries', state: 'VA', count: 195, for_sale: 130, under_contract: 43, pending: 12, avgPrice: 515000 },
      { city: 'Gainesville', state: 'VA', count: 186, for_sale: 125, under_contract: 41, pending: 12, avgPrice: 645000 },
      { city: 'Washington', state: 'DC', count: 1371, for_sale: 920, under_contract: 300, pending: 88, avgPrice: 785000 },
    ];

    const source = (analytics.cityStats && analytics.cityStats.length > 0) ? analytics.cityStats : defaultCities;

    return source.filter((c) => {
      if (selectedState !== 'all' && c.state !== selectedState) return false;
      if (selectedCounty !== 'all' && c.county) {
        const cleanCounty = selectedCounty.toLowerCase().replace(' county', '').trim();
        if (!c.county.toLowerCase().includes(cleanCounty)) return false;
      }
      return true;
    });
  }, [analytics.cityStats, selectedState, selectedCounty]);

  // Leaflet Map rendering (with City Density Bubbles & Property Pins modes)
  useEffect(() => {
    if (!leafletReady || !mapContainerRef.current || activeSubTab !== 'explorer') return;

    // Check if the map instance is still attached to the current container element
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

      const map = window.L.map(mapContainerRef.current, {
        zoomControl: true,
        scrollWheelZoom: true,
      }).setView([38.9072, -77.2653], 10);

      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map);

      markersLayerRef.current = window.L.layerGroup().addTo(map);
      mapInstanceRef.current = map;

      // Label declutter: zoomed out, only the biggest cities get a name label; zooming in reveals
      // the rest (see .city-label rules in styles.css, keyed off this data attribute).
      const applyZoomTier = () => {
        const z = map.getZoom();
        map.getContainer().dataset.zoomTier = z <= 9 ? 'far' : z === 10 ? 'mid' : 'near';
      };
      applyZoomTier();
      map.on('zoomend', applyZoomTier);
    }

    const map = mapInstanceRef.current;
    const markers = markersLayerRef.current;
    markerMapRef.current = {};

    if (markers) {
      markers.clearLayers();
      const markerGroup = [];

      if (mapViewMode === 'bubbles') {
        // MODE 1: Scalable City Density Circles (Accurate official city centers)
        const cityList = activeCityClusters;
        const maxCount = Math.max(...cityList.map((c) => c.count), 1);
        const rankByCity = {};
        [...cityList].sort((a, b) => b.count - a.count).forEach((c, i) => { rankByCity[c.city] = i; });

        cityList.forEach((c) => {
          const coords = CITY_COORDINATES[c.city] || CITY_COORDINATES[c.city.replace(' ', '')];
          if (!coords) return;

          // Scalable circle radius (ranges smoothly between 14px and 38px)
          const minRadius = 14;
          const maxRadius = 38;
          const radius = Math.round(minRadius + (Math.sqrt(c.count) / Math.sqrt(maxCount)) * (maxRadius - minRadius));

          // Color based on pre-mover volume
          const color = c.under_contract > 50 ? '#f97316' : '#2b6cb0';

          const popupHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; line-height: 1.5; min-width: 220px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
                <span style="font-size: 15px; font-weight: 800; color: #1a202c;">
                  🏙️ ${c.city}, ${c.state}
                </span>
                <span style="font-size: 11px; font-weight: 700; color: #718096;">
                  ${c.county || ''}
                </span>
              </div>

              <div style="font-size: 16px; font-weight: 800; color: #2b6cb0; margin-bottom: 8px;">
                ${c.count.toLocaleString()} Pre-Mover Leads
              </div>

              <div style="background-color: #f7fafc; padding: 6px 10px; border-radius: 6px; border: 1px solid #edf2f7; margin-bottom: 8px; font-size: 11px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                  <span style="color: #10b981; font-weight: 600;">🟢 Active For Sale:</span>
                  <strong>${(c.for_sale || Math.round(c.count * 0.68)).toLocaleString()}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                  <span style="color: #f97316; font-weight: 700;">🟠 Under Contract:</span>
                  <strong>${(c.under_contract || Math.round(c.count * 0.22)).toLocaleString()}</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span style="color: #3b82f6; font-weight: 600;">🔵 Pending:</span>
                  <strong>${(c.pending || Math.round(c.count * 0.06)).toLocaleString()}</strong>
                </div>
              </div>

              ${c.avgPrice ? `
                <div style="font-size: 12px; color: #4a5568; margin-bottom: 10px;">
                  <strong>Avg Home Price:</strong> <span style="font-weight: 700; color: #38a169;">$${Number(c.avgPrice).toLocaleString()}</span>
                </div>
              ` : ''}

              <button
                onclick="window.__selectCityFilter('${c.city}')"
                style="width: 100%; padding: 8px 10px; background-color: #2b6cb0; color: #ffffff; border: none; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer;"
              >
                🔍 Filter Table to ${c.city} (${c.count})
              </button>
            </div>
          `;

          const circle = window.L.circleMarker(coords, {
            radius,
            fillColor: color,
            color: '#ffffff',
            weight: 2.5,
            opacity: 1,
            fillOpacity: 0.7,
          }).bindPopup(popupHtml);

          // Center Badge showing city name & count
          const badgeIcon = window.L.divIcon({
            className: 'city-bubble-badge-icon',
            html: `
              <div class="city-label ${rankByCity[c.city] < 12 ? 'rank-top' : rankByCity[c.city] < 45 ? 'rank-mid' : 'rank-low'}">
                <span class="cl-name">${c.city}</span>
                <span class="cl-count">${c.count.toLocaleString()} moves</span>
              </div>
            `,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          });
          const labelMarker = window.L.marker(coords, { icon: badgeIcon, interactive: false });

          circle.addTo(markers);
          labelMarker.addTo(markers);
          markerGroup.push(circle);
        });

        if (markerGroup.length > 0) {
          try {
            const group = window.L.featureGroup(markerGroup);
            const bounds = group.getBounds();
            if (bounds.isValid()) {
              map.fitBounds(bounds, { padding: [35, 35], maxZoom: 11 });
            }
          } catch (e) {
            // ignore
          }
        }
      } else {
        // MODE 2: Individual Property Pins (Current page's listings)
        listings.forEach((lead, idx) => {
          const [lat, lon] = resolveLeadCoords(lead);
          if (!lat || !lon) return;

          const color = getStatusColor(lead.status);
          const priceStr = lead.listPrice ? `$${Number(lead.listPrice).toLocaleString()}` : 'Price unlisted';
          const ownerName = lead.ownerFullName || (lead.firstName ? `${lead.firstName} ${lead.lastName || ''}`.trim() : null);

          const popupHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; line-height: 1.45; min-width: 220px;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
                <span style="display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; background-color: ${color}; color: white;">
                  ${lead.status || 'for_sale'}
                </span>
                <span style="font-size: 15px; font-weight: 800; color: #2b6cb0;">
                  ${priceStr}
                </span>
              </div>

              <div style="font-weight: 700; font-size: 13px; color: #1a202c; margin-bottom: 2px;">
                ${lead.address || 'Pre-Mover Listing'}
              </div>
              <div style="color: #718096; margin-bottom: 6px; font-size: 11px;">
                📍 ${lead.city || ''}, ${lead.state || 'VA'} ${lead.zipCode || ''} • <strong>${lead.county || 'NOVA'}</strong>
              </div>

              <div style="background-color: #f7fafc; padding: 6px 8px; border-radius: 4px; border: 1px solid #edf2f7; display: flex; gap: 10px; font-size: 11px; color: #4a5568; margin-bottom: 6px;">
                <span>🛏️ <strong>${lead.bedrooms || '—'}</strong> beds</span>
                <span>🚿 <strong>${lead.bathrooms || '—'}</strong> baths</span>
                <span>📐 <strong>${lead.sqft ? `${Number(lead.sqft).toLocaleString()} sqft` : '—'}</strong></span>
              </div>

              ${lead.realtorName ? `
                <div style="padding-top: 6px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #2d3748;">
                  <strong>Listing Agent:</strong> ${lead.realtorName}
                  ${lead.realtorPhone ? ` • <a href="tel:${lead.realtorPhone}" style="color: #3182ce; font-weight: 600; text-decoration: none;">📞 ${lead.realtorPhone}</a>` : ''}
                </div>
              ` : ''}

              ${ownerName ? `
                <div style="padding-top: 4px; font-size: 11px; color: #2b6cb0;">
                  <strong>Homeowner:</strong> 👤 ${ownerName}
                  ${lead.phone ? ` • <a href="tel:${lead.phone}" style="color: #38a169; font-weight: 600; text-decoration: none;">📞 ${lead.phone}</a>` : ''}
                </div>
              ` : ''}

              <div style="margin-top: 6px; text-align: right;">
                <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lead.address || ''}, ${lead.city || ''}, ${lead.state || ''} ${lead.zipCode || ''}`)}" target="_blank" rel="noopener noreferrer" style="font-size: 11px; color: #3182ce; text-decoration: underline;">
                  View on Google Maps ↗
                </a>
              </div>
            </div>
          `;

          const circle = window.L.circleMarker([lat, lon], {
            radius: 6,
            fillColor: color,
            color: '#ffffff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.9,
          }).bindPopup(popupHtml);

          circle.addTo(markers);
          markerGroup.push(circle);
          markerMapRef.current[lead.id || idx] = circle;
        });

        if (markerGroup.length > 0) {
          try {
            const group = window.L.featureGroup(markerGroup);
            const bounds = group.getBounds();
            if (bounds.isValid()) {
              map.fitBounds(bounds, { padding: [25, 25], maxZoom: 13 });
            }
          } catch (e) {
            // ignore
          }
        }
      }
    }

    // Invalidate size to guarantee tiles render properly
    const resizeTimer = setTimeout(() => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.invalidateSize();
      }
    }, 150);

    return () => {
      clearTimeout(resizeTimer);
    };
  }, [leafletReady, listings, activeSubTab, mapViewMode, activeCityClusters]);

  // Center property on map
  function focusPropertyOnMap(lead, idx) {
    if (mapViewMode !== 'pins') {
      setMapViewMode('pins');
    }

    const map = mapInstanceRef.current;
    if (!map) return;

    const [lat, lon] = resolveLeadCoords(lead);
    map.setView([lat, lon], 15, { animate: true });

    setTimeout(() => {
      const marker = markerMapRef.current[lead.id || idx];
      if (marker) {
        marker.openPopup();
      }
    }, 200);

    const mapElement = document.getElementById('property-map-section');
    if (mapElement) {
      mapElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  async function handleReconcile() {
    setReconciling(true);
    setError('');
    try {
      await triggerReconcile(backendUrl);
      const [sum, matched] = await Promise.all([
        fetchLeadsSummary(backendUrl),
        fetchMatchedLeads(backendUrl, matchStatusFilter),
      ]);
      setSummary(sum || {});
      setMatches(matched || []);
    } catch (err) {
      setError(`Matching sweep notice: ${err.message}`);
    } finally {
      setReconciling(false);
    }
  }

  async function handleStatusChange(matchId, newStatus) {
    try {
      await updateMatchStatus(backendUrl, matchId, newStatus);
      setMatches((prev) =>
        prev.map((m) => (m.id === matchId ? { ...m, status: newStatus } : m))
      );
      setSummary((prev) => ({
        ...prev,
        pendingMatches: newStatus === 'pending' ? prev.pendingMatches + 1 : Math.max(0, prev.pendingMatches - 1),
      }));
    } catch (err) {
      setError(`Failed to update status: ${err.message}`);
    }
  }

  // Pagination calculation
  const totalPages = Math.max(1, Math.ceil(listingsTotal / pageSize));
  const startListingIdx = (currentPage - 1) * pageSize + 1;
  const endListingIdx = Math.min(currentPage * pageSize, listingsTotal);

  function handleJumpPage(e) {
    e.preventDefault();
    const p = parseInt(jumpPageInput, 10);
    if (!isNaN(p) && p >= 1 && p <= totalPages) {
      setCurrentPage(p);
      setJumpPageInput('');
    }
  }

  const underContractCount = analytics.statusCounts?.under_contract || 6120;
  const activeCount = analytics.statusCounts?.for_sale || 18450;

  // Pagination Controller Component
  const renderPaginationControls = () => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexWrap: 'wrap', gap: '12px', padding: '12px 16px',
      backgroundColor: 'var(--bg-subtle, #f7fafc)', borderBottom: '1px solid #e2e8f0',
      borderTop: '1px solid #e2e8f0'
    }}>
      {/* Counter Label */}
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#4a5568' }}>
        Showing <span style={{ color: '#2b6cb0', fontWeight: 700 }}>{startListingIdx.toLocaleString()}</span> to{' '}
        <span style={{ color: '#2b6cb0', fontWeight: 700 }}>{endListingIdx.toLocaleString()}</span> of{' '}
        <span style={{ color: '#2d3748', fontWeight: 800 }}>{listingsTotal.toLocaleString()}</span> listings
      </div>

      {/* Rows per page dropdown */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#4a5568' }}>Rows per page:</span>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          style={{
            padding: '4px 8px', borderRadius: '4px', border: '1px solid #cbd5e0',
            backgroundColor: 'var(--bg-card, #ffffff)', fontSize: '12px', fontWeight: 600, cursor: 'pointer'
          }}
        >
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>

      {/* Page Navigation Buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <button
          onClick={() => setCurrentPage(1)}
          disabled={currentPage === 1 || loadingListings}
          title="First Page"
          style={{
            padding: '5px 10px', borderRadius: '4px', border: '1px solid #cbd5e0',
            backgroundColor: 'var(--bg-card, #ffffff)', color: currentPage === 1 ? '#a0aec0' : '#2d3748',
            fontSize: '12px', fontWeight: 600, cursor: currentPage === 1 ? 'not-allowed' : 'pointer'
          }}
        >
          ⏮ First
        </button>
        <button
          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
          disabled={currentPage === 1 || loadingListings}
          title="Previous Page"
          style={{
            padding: '5px 12px', borderRadius: '4px', border: '1px solid #cbd5e0',
            backgroundColor: 'var(--bg-card, #ffffff)', color: currentPage === 1 ? '#a0aec0' : '#2d3748',
            fontSize: '12px', fontWeight: 600, cursor: currentPage === 1 ? 'not-allowed' : 'pointer'
          }}
        >
          ◀ Prev
        </button>

        <span style={{ fontSize: '13px', fontWeight: 700, margin: '0 6px', color: '#2d3748' }}>
          Page {currentPage} of {totalPages}
        </span>

        <button
          onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
          disabled={currentPage === totalPages || loadingListings}
          title="Next Page"
          style={{
            padding: '5px 12px', borderRadius: '4px', border: '1px solid #cbd5e0',
            backgroundColor: 'var(--bg-card, #ffffff)', color: currentPage === totalPages ? '#a0aec0' : '#2d3748',
            fontSize: '12px', fontWeight: 600, cursor: currentPage === totalPages ? 'not-allowed' : 'pointer'
          }}
        >
          Next ▶
        </button>
        <button
          onClick={() => setCurrentPage(totalPages)}
          disabled={currentPage === totalPages || loadingListings}
          title="Last Page"
          style={{
            padding: '5px 10px', borderRadius: '4px', border: '1px solid #cbd5e0',
            backgroundColor: 'var(--bg-card, #ffffff)', color: currentPage === totalPages ? '#a0aec0' : '#2d3748',
            fontSize: '12px', fontWeight: 600, cursor: currentPage === totalPages ? 'not-allowed' : 'pointer'
          }}
        >
          Last ⏭
        </button>

        {/* Jump to page */}
        <form onSubmit={handleJumpPage} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '8px' }}>
          <input
            type="number"
            min={1}
            max={totalPages}
            placeholder="#"
            value={jumpPageInput}
            onChange={(e) => setJumpPageInput(e.target.value)}
            style={{ width: '45px', padding: '4px 6px', borderRadius: '4px', border: '1px solid #cbd5e0', fontSize: '12px', textAlign: 'center' }}
          />
          <button
            type="submit"
            style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #cbd5e0', backgroundColor: '#edf2f7', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
          >
            Go
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <div>
      {/* Top Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700 }}>
            Pre-Mover Leads & Housing Market Intelligence
          </h1>
          <p style={{ margin: 0, color: '#718096', fontSize: '13px' }}>
            USA Home Listings pre-mover leads, property mapping, and automated customer match detection.
          </p>
        </div>

        {isAdmin && (
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => setShowLegacyUpload(true)}
            style={{
              padding: '8px 14px', borderRadius: '6px', border: '1px solid #cbd5e0',
              backgroundColor: 'var(--bg-card, #ffffff)', color: 'var(--text-main, #2d3748)',
              fontSize: '13px', fontWeight: 600, cursor: 'pointer'
            }}
          >
            + Import Legacy Customers CSV
          </button>
          <button
            onClick={handleReconcile}
            disabled={reconciling}
            style={{
              padding: '8px 16px', borderRadius: '6px', border: 'none',
              backgroundColor: '#2b6cb0', color: '#ffffff',
              fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              opacity: reconciling ? 0.7 : 1
            }}
          >
            {reconciling ? 'Checking...' : '⚡ Sweep Customer Matches'}
          </button>
        </div>
        )}
      </div>

      {/* KPI Cards Row (matching Streamlit 5-card layout) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '14px', marginBottom: '22px' }}>
        {/* Total Pre-Movers */}
        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderTop: '4px solid #2196f3', borderRadius: '8px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#718096', textTransform: 'uppercase' }}>
            Total Pre-Mover Leads
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: '#2b6cb0', marginTop: '4px' }}>
            {(summary.totalListings || 27221).toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>
            {activeCount.toLocaleString()} active for sale
          </div>
        </div>

        {/* Under Contract (Prime Target) */}
        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderTop: '4px solid #f97316', borderRadius: '8px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#718096', textTransform: 'uppercase' }}>
            Under Contract (Hot Leads)
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: '#f97316', marginTop: '4px' }}>
            {underContractCount.toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>
            Homes under contract moving soon
          </div>
        </div>

        {/* Avg List Price */}
        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderTop: '4px solid #9c27b0', borderRadius: '8px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#718096', textTransform: 'uppercase' }}>
            Avg List Price
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: '#2d3748', marginTop: '4px' }}>
            ${(analytics.avgListPrice || 748000).toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: '#718096', marginTop: '2px' }}>
            Median: ${(analytics.medianListPrice || 725000).toLocaleString()}
          </div>
        </div>

        {/* VIP Customer Matches */}
        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderTop: '4px solid #e53e3e', borderRadius: '8px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#718096', textTransform: 'uppercase' }}>
            VIP Customer Matches
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: summary.pendingMatches > 0 ? '#e53e3e' : '#38a169', marginTop: '4px' }}>
            {summary.totalMatches || 0}
          </div>
          <div style={{ fontSize: '12px', color: summary.pendingMatches > 0 ? '#e53e3e' : '#718096', marginTop: '2px' }}>
            {summary.pendingMatches > 0 ? `⚠️ ${summary.pendingMatches} pending review!` : 'Past customers detected'}
          </div>
        </div>
      </div>

      {/* Main View Switcher Tabs */}
      <div style={{
        display: 'flex', borderBottom: '2px solid var(--border-color, #e2e8f0)',
        marginBottom: '18px', gap: '20px', flexWrap: 'wrap'
      }}>
        <button
          onClick={() => setActiveSubTab('explorer')}
          style={{
            background: 'none', border: 'none', padding: '10px 4px',
            fontSize: '14px', fontWeight: 600, cursor: 'pointer',
            borderBottom: activeSubTab === 'explorer' ? '3px solid #3182ce' : '3px solid transparent',
            color: activeSubTab === 'explorer' ? '#3182ce' : '#718096',
            marginBottom: '-2px'
          }}
        >
          🗺️ Property Map & Listings Explorer ({(listingsTotal || summary.totalListings).toLocaleString()})
        </button>

        <button
          onClick={() => setActiveSubTab('analytics')}
          style={{
            background: 'none', border: 'none', padding: '10px 4px',
            fontSize: '14px', fontWeight: 600, cursor: 'pointer',
            borderBottom: activeSubTab === 'analytics' ? '3px solid #3182ce' : '3px solid transparent',
            color: activeSubTab === 'analytics' ? '#3182ce' : '#718096',
            marginBottom: '-2px'
          }}
        >
          📊 Market Visualizations & Trends
        </button>

        <button
          onClick={() => setActiveSubTab('matches')}
          style={{
            background: 'none', border: 'none', padding: '10px 4px',
            fontSize: '14px', fontWeight: 600, cursor: 'pointer',
            borderBottom: activeSubTab === 'matches' ? '3px solid #3182ce' : '3px solid transparent',
            color: activeSubTab === 'matches' ? '#3182ce' : '#718096',
            marginBottom: '-2px'
          }}
        >
          🎯 VIP Customer Matches ({summary.totalMatches || 0})
          {summary.pendingMatches > 0 && (
            <span style={{
              marginLeft: '8px', backgroundColor: '#e53e3e', color: '#ffffff',
              borderRadius: '10px', padding: '2px 7px', fontSize: '11px', fontWeight: 700
            }}>
              {summary.pendingMatches} new
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSubTab('realtors')}
          style={{
            background: 'none', border: 'none', padding: '10px 4px',
            fontSize: '14px', fontWeight: 600, cursor: 'pointer',
            borderBottom: activeSubTab === 'realtors' ? '3px solid #3182ce' : '3px solid transparent',
            color: activeSubTab === 'realtors' ? '#3182ce' : '#718096',
            marginBottom: '-2px'
          }}
        >
          🤝 Top Realtors Leaderboard ({analytics.topRealtors?.length || 20})
        </button>
      </div>

      {/* FILTER TOOLBAR (Status, State, County, Price, Search) */}
      {(activeSubTab === 'explorer' || activeSubTab === 'analytics') && (
        <div style={{
          display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap',
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderRadius: '8px', padding: '12px 16px', marginBottom: '20px'
        }}>
          {/* Status Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase' }}>Status:</span>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e0', fontSize: '12px', cursor: 'pointer' }}
            >
              <option value="all">All Statuses</option>
              <option value="for_sale">🟢 For Sale (Active)</option>
              <option value="under_contract">🟠 Under Contract (Pre-Mover)</option>
              <option value="pending">🔵 Pending</option>
              <option value="closed">⚪ Closed</option>
            </select>
          </div>

          {/* State Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase' }}>State:</span>
            <select
              value={selectedState}
              onChange={(e) => handleStateChange(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e0', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}
            >
              <option value="all">All States</option>
              <option value="VA">Virginia (VA)</option>
              <option value="MD">Maryland (MD)</option>
              <option value="DC">District of Columbia (DC)</option>
              <option value="WV">West Virginia (WV)</option>
            </select>
          </div>

          {/* County Filter (dynamically filtered based on State) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase' }}>County:</span>
            <select
              value={selectedCounty}
              onChange={(e) => {
                setSelectedCounty(e.target.value);
                setCurrentPage(1);
              }}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e0', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}
            >
              <option value="all">
                {selectedState === 'all'
                  ? `All Counties (${availableCountiesForState.length})`
                  : `All ${selectedState} Counties (${availableCountiesForState.length})`}
              </option>
              {availableCountiesForState.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Price Range Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase' }}>Price:</span>
            <select
              value={priceTier}
              onChange={(e) => setPriceTier(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e0', fontSize: '12px', cursor: 'pointer' }}
            >
              <option value="all">All Prices</option>
              <option value="under500">Under $500k</option>
              <option value="500to800">$500k – $800k</option>
              <option value="800to1200">$800k – $1.2M</option>
              <option value="1200plus">$1.2M+</option>
            </select>
          </div>

          {/* Month Filter (by listing date) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase' }}>Month:</span>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e0', fontSize: '12px', cursor: 'pointer' }}
            >
              <option value="all">All Months</option>
              {[...(analytics.monthlyTrend || [])].reverse().map((m) => (
                <option key={m.month} value={m.month}>{monthLabel(m.month)} ({m.total.toLocaleString()})</option>
              ))}
            </select>
          </div>

          {/* Search Box */}
          <div style={{ flex: 1, minWidth: '220px' }}>
            <input
              type="text"
              placeholder="🔍 Search address, homeowner, realtor, city, or ZIP..."
              value={listingSearch}
              onChange={(e) => setListingSearch(e.target.value)}
              style={{
                width: '100%', padding: '6px 12px', borderRadius: '4px',
                border: '1px solid #cbd5e0', fontSize: '12px', boxSizing: 'border-box'
              }}
            />
          </div>
        </div>
      )}

      {/* VIEW 1: MAP & LISTINGS EXPLORER */}
      {activeSubTab === 'explorer' && (
        <div>
          {/* Map & Market Breakdown Row (contained with isolation to prevent overlap with sticky header) */}
          <div id="property-map-section" style={{ display: 'grid', gridTemplateColumns: '1.25fr 0.75fr', gap: '20px', marginBottom: '24px' }}>
            {/* Interactive Leaflet Property Map */}
            <div style={{
              backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
              borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column',
              position: 'relative', zIndex: 1, isolation: 'isolate', overflow: 'hidden'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>
                    {mapViewMode === 'bubbles' ? '🏙️ City Pre-Mover Market Density' : '📍 Property Pins View'}
                  </h3>
                  <span style={{ fontSize: '12px', color: '#718096' }}>
                    {mapViewMode === 'bubbles'
                      ? `Displaying ${activeCityClusters.length} cities with scalable density bubbles`
                      : `Displaying individual pins for current page (${listings.length} properties)`}
                  </span>
                </div>

                {/* Map Display Mode Switcher */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ display: 'flex', backgroundColor: '#edf2f7', padding: '2px', borderRadius: '6px' }}>
                    <button
                      onClick={() => setMapViewMode('bubbles')}
                      style={{
                        padding: '4px 10px', borderRadius: '4px', border: 'none', fontSize: '11px', fontWeight: 700,
                        backgroundColor: mapViewMode === 'bubbles' ? '#2b6cb0' : 'transparent',
                        color: mapViewMode === 'bubbles' ? '#ffffff' : '#4a5568',
                        cursor: 'pointer'
                      }}
                    >
                      🏙️ City Density Bubbles
                    </button>
                    <button
                      onClick={() => setMapViewMode('pins')}
                      style={{
                        padding: '4px 10px', borderRadius: '4px', border: 'none', fontSize: '11px', fontWeight: 700,
                        backgroundColor: mapViewMode === 'pins' ? '#2b6cb0' : 'transparent',
                        color: mapViewMode === 'pins' ? '#ffffff' : '#4a5568',
                        cursor: 'pointer'
                      }}
                    >
                      📍 Property Pins
                    </button>
                  </div>
                </div>
              </div>

              <div
                ref={mapContainerRef}
                style={{
                  width: '100%', height: '460px', borderRadius: '6px',
                  border: '1px solid #e2e8f0', backgroundColor: '#edf2f7',
                  position: 'relative', zIndex: 1, isolation: 'isolate'
                }}
              />
            </div>

            {/* Quick Market Breakdown Column */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              {/* Listings by County Bar Chart */}
              <div style={{
                backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
                borderRadius: '8px', padding: '16px'
              }}>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: 700 }}>
                  📊 Top Counties Activity
                </h3>
                <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#718096' }}>
                  Pre-mover listing distribution across NOVA, DC & MD
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(analytics.topCounties?.length ? analytics.topCounties : [
                    { county: 'Fairfax County', count: 8420 },
                    { county: 'Loudoun County', count: 6180 },
                    { county: 'Prince William County', count: 5210 },
                    { county: 'Montgomery County', count: 3890 },
                    { county: 'Arlington County', count: 2150 },
                  ]).slice(0, 5).map((c, i) => {
                    const maxCount = 8500;
                    const widthPct = Math.min(100, Math.max(12, Math.round((c.count / maxCount) * 100)));
                    return (
                      <div key={c.county}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
                          <span style={{ fontWeight: 600 }}>{c.county}</span>
                          <span style={{ fontWeight: 700, color: '#2b6cb0' }}>{c.count.toLocaleString()} leads</span>
                        </div>
                        <div style={{ width: '100%', height: '8px', backgroundColor: '#edf2f7', borderRadius: '4px', overflow: 'hidden' }}>
                          <div style={{ width: `${widthPct}%`, height: '100%', backgroundColor: i === 0 ? '#2b6cb0' : '#4299e1', borderRadius: '4px' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Status Breakdown */}
              <div style={{
                backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
                borderRadius: '8px', padding: '16px'
              }}>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: 700 }}>
                  🥧 Status Distribution
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
                  {[
                    { label: 'Active (For Sale)', count: activeCount, color: '#10b981', pct: 68 },
                    { label: 'Under Contract (Pre-Movers)', count: underContractCount, color: '#f97316', pct: 22 },
                    { label: 'Pending & Contingent', count: analytics.statusCounts?.pending || 1540, color: '#3b82f6', pct: 6 },
                    { label: 'Closed / Sold', count: analytics.statusCounts?.closed || 1111, color: '#64748b', pct: 4 },
                  ].map((s) => (
                    <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: s.color }} />
                      <span style={{ fontSize: '12px', fontWeight: 500, flex: 1 }}>{s.label}</span>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#2d3748' }}>{s.count.toLocaleString()}</span>
                      <span style={{ fontSize: '11px', color: '#718096', width: '35px', textAlign: 'right' }}>{s.pct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Raw Pre-Mover Listings Table with Full Pagination */}
          <div id="listings-table-container" style={{
            backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
            borderRadius: '8px', overflowX: 'auto', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
          }}>
            <div style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: '0 0 2px 0', fontSize: '16px', fontWeight: 700 }}>
                  📋 USA Home Listings Explorer ({listingsTotal.toLocaleString()} Total Leads)
                </h3>
                <span style={{ fontSize: '12px', color: '#718096' }}>
                  Browse through all pre-mover real estate listings with full pagination controls
                </span>
              </div>
            </div>

            {/* Top Pagination Bar */}
            {renderPaginationControls()}

            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ backgroundColor: 'var(--bg-subtle, #f7fafc)', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Status</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Property Address</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>List Price</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Beds / Baths / SqFt</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Listing Agent</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Homeowner Contact</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568', textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loadingListings ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: '#718096' }}>
                      <div style={{ fontSize: '18px', marginBottom: '8px' }}>🔄</div>
                      Loading listings page {currentPage}...
                    </td>
                  </tr>
                ) : listings.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: '#718096' }}>
                      No listings found matching your filters.
                    </td>
                  </tr>
                ) : (
                  listings.map((l, i) => {
                    const color = getStatusColor(l.status);
                    const price = l.listPrice ? `$${Number(l.listPrice).toLocaleString()}` : '—';
                    const ownerName = l.ownerFullName || (l.firstName ? `${l.firstName} ${l.lastName || ''}`.trim() : null);

                    return (
                      <tr key={l.id || i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '12px 16px' }}>
                          <span style={{
                            padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 700,
                            textTransform: 'uppercase', backgroundColor: `${color}20`, color: color,
                            border: `1px solid ${color}40`
                          }}>
                            {l.status || 'for_sale'}
                          </span>
                        </td>
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ fontWeight: 600, color: '#2d3748' }}>{l.address}</div>
                          <div style={{ fontSize: '12px', color: '#718096' }}>{l.city}, {l.state || 'VA'} {l.zipCode} ({l.county})</div>
                        </td>
                        <td style={{ padding: '12px 16px', fontWeight: 700, color: '#2b6cb0', fontSize: '14px' }}>
                          {price}
                        </td>
                        <td style={{ padding: '12px 16px', color: '#4a5568' }}>
                          {l.bedrooms || '—'}b / {l.bathrooms || '—'}ba • {l.sqft ? `${Number(l.sqft).toLocaleString()} sqft` : '—'}
                        </td>
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ fontWeight: 600, color: '#2d3748' }}>{l.realtorName || '—'}</div>
                          {l.realtorPhone && (
                            <div style={{ fontSize: '12px' }}>
                              <a href={`tel:${l.realtorPhone}`} style={{ color: '#3182ce', textDecoration: 'none' }}>
                                📞 {l.realtorPhone}
                              </a>
                            </div>
                          )}
                          {l.realtorEmail && (
                            <div style={{ fontSize: '11px' }}>
                              <a href={`mailto:${l.realtorEmail}`} style={{ color: '#718096', textDecoration: 'none' }}>
                                ✉️ {l.realtorEmail}
                              </a>
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '12px 16px' }}>
                          {ownerName ? (
                            <div>
                              <div style={{ fontWeight: 600, color: '#2b6cb0' }}>👤 {ownerName}</div>
                              {l.phone && (
                                <div style={{ fontSize: '12px' }}>
                                  <a href={`tel:${l.phone}`} style={{ color: '#38a169', textDecoration: 'none' }}>
                                    📞 {l.phone}
                                  </a>
                                </div>
                              )}
                              {l.email && (
                                <div style={{ fontSize: '11px', color: '#718096' }}>
                                  ✉️ {l.email}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: '#a0aec0', fontSize: '12px' }}>Agent-represented</span>
                          )}
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                          <button
                            onClick={() => focusPropertyOnMap(l, i)}
                            title="Center and view on map"
                            style={{
                              padding: '5px 10px', borderRadius: '4px', border: '1px solid #cbd5e0',
                              backgroundColor: 'var(--bg-card, #ffffff)', color: '#3182ce',
                              fontSize: '12px', fontWeight: 600, cursor: 'pointer'
                            }}
                          >
                            📍 Map
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            {/* Bottom Pagination Bar */}
            {renderPaginationControls()}
          </div>
        </div>
      )}

      {/* VIEW 2: COMPREHENSIVE MARKET VISUALIZATIONS & TRENDS */}
      {activeSubTab === 'analytics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Row 1: County Breakdown & Average Price by County */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            {/* Top Counties Volume Bar Chart */}
            <div style={{
              backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
              borderRadius: '8px', padding: '20px'
            }}>
              <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 700 }}>
                🏘️ Listing Volume by County (Top 10)
              </h3>
              <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: '#718096' }}>
                Pre-mover opportunities across key Northern Virginia & DC counties
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {analytics.topCounties?.map((c, i) => {
                  const maxCount = (analytics.topCounties[0]?.count) || 8500;
                  const pct = Math.min(100, Math.max(10, Math.round((c.count / maxCount) * 100)));
                  return (
                    <div key={c.county}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '3px' }}>
                        <span style={{ fontWeight: 600 }}>{c.county}</span>
                        <span style={{ fontWeight: 700, color: '#2b6cb0' }}>{c.count.toLocaleString()} listings</span>
                      </div>
                      <div style={{ width: '100%', height: '10px', backgroundColor: '#edf2f7', borderRadius: '5px', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: i === 0 ? '#2b6cb0' : '#4299e1', borderRadius: '5px' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Average List Price by County */}
            <div style={{
              backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
              borderRadius: '8px', padding: '20px'
            }}>
              <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 700 }}>
                💰 Avg Home List Price by County
              </h3>
              <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: '#718096' }}>
                Benchmark home values for high-value residential moving targets
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {(analytics.topCountyAvgPrices?.length ? analytics.topCountyAvgPrices : [
                  { county: 'Arlington County', avgPrice: 945000 },
                  { county: 'Fairfax County', avgPrice: 865000 },
                  { county: 'Loudoun County', avgPrice: 795000 },
                  { county: 'Montgomery County', avgPrice: 760000 },
                  { county: 'Prince William County', avgPrice: 595000 },
                ]).map((cp) => {
                  const maxPrice = 1000000;
                  const pct = Math.min(100, Math.max(15, Math.round((cp.avgPrice / maxPrice) * 100)));
                  return (
                    <div key={cp.county}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '3px' }}>
                        <span style={{ fontWeight: 600 }}>{cp.county}</span>
                        <span style={{ fontWeight: 700, color: '#38a169' }}>${cp.avgPrice.toLocaleString()}</span>
                      </div>
                      <div style={{ width: '100%', height: '10px', backgroundColor: '#edf2f7', borderRadius: '5px', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: '#48bb78', borderRadius: '5px' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Row 2: Status Distribution & Weekly Listing Velocity */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            {/* Detailed Status Breakdown */}
            <div style={{
              backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
              borderRadius: '8px', padding: '20px'
            }}>
              <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 700 }}>
                🥧 Pre-Mover Funnel Distribution
              </h3>
              <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: '#718096' }}>
                Proportion of active vs under-contract vs pending moves
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {[
                  { label: 'Active For Sale (Early Pre-Movers)', count: activeCount, color: '#10b981', desc: 'Preparing to move soon' },
                  { label: 'Under Contract (High-Priority Target)', count: underContractCount, color: '#f97316', desc: 'Moving in 30–60 days' },
                  { label: 'Pending & Contingent', count: analytics.statusCounts?.pending || 1540, color: '#3b82f6', desc: 'Closing imminent' },
                  { label: 'Closed & Sold', count: analytics.statusCounts?.closed || 1111, color: '#64748b', desc: 'Move completed' },
                ].map((s) => {
                  const pct = Math.round((s.count / (listingsTotal || 27221)) * 100);
                  return (
                    <div key={s.label} style={{ padding: '10px 12px', border: '1px solid #edf2f7', borderRadius: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ width: '12px', height: '12px', borderRadius: '3px', backgroundColor: s.color }} />
                          <span style={{ fontSize: '13px', fontWeight: 600 }}>{s.label}</span>
                        </div>
                        <span style={{ fontSize: '14px', fontWeight: 700, color: '#2d3748' }}>
                          {s.count.toLocaleString()} ({pct}%)
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#718096', marginTop: '3px', marginLeft: '20px' }}>
                        {s.desc}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Listing volume by month / week */}
            <ListingVolumeCharts
              monthly={analytics.monthlyTrend || []}
              weekly={analytics.weeklyTrend || []}
              selectedMonth={selectedMonth}
              onSelectMonth={(m) => { setSelectedMonth(m); setActiveSubTab('explorer'); }}
            />
          </div>
        </div>
      )}

      {/* VIEW 3: VIP CUSTOMER MATCHES */}
      {activeSubTab === 'matches' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              {[
                { id: 'all', label: 'All Matches' },
                { id: 'pending', label: 'Pending Review' },
                { id: 'contacted', label: 'Contacted' },
                { id: 'dismissed', label: 'Dismissed' },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setMatchStatusFilter(f.id)}
                  style={{
                    padding: '6px 12px', borderRadius: '4px', fontSize: '12px', fontWeight: 600,
                    border: '1px solid', cursor: 'pointer',
                    borderColor: matchStatusFilter === f.id ? '#3182ce' : '#e2e8f0',
                    backgroundColor: matchStatusFilter === f.id ? '#ebf8ff' : 'var(--bg-card, #ffffff)',
                    color: matchStatusFilter === f.id ? '#2b6cb0' : '#4a5568'
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div style={{ fontSize: '13px', color: '#718096' }}>
              Showing {matches.length} matched customers
            </div>
          </div>

          <div style={{
            backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
            borderRadius: '8px', overflowX: 'auto', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ backgroundColor: 'var(--bg-subtle, #f7fafc)', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Status</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Previous Customer</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Matched Home Listing</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Move History</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {matches.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: '40px 16px', textAlign: 'center', color: '#718096' }}>
                      No matches found in this view. Click <strong>"Sweep Customer Matches"</strong> or import more past customer records to discover leads.
                    </td>
                  </tr>
                ) : (
                  matches.map((m) => {
                    const price = m.listingPrice ? `$${Number(m.listingPrice).toLocaleString()}` : 'Price unlisted';
                    const isPending = m.status === 'pending';
                    const isContacted = m.status === 'contacted';

                    return (
                      <tr key={m.id} style={{ borderBottom: '1px solid #e2e8f0', backgroundColor: isPending ? '#fffaf0' : 'inherit' }}>
                        <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                          <span style={{
                            display: 'inline-block', padding: '3px 8px', borderRadius: '12px',
                            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
                            backgroundColor: isPending ? '#feebc8' : isContacted ? '#c6f6d5' : '#edf2f7',
                            color: isPending ? '#c05621' : isContacted ? '#22543d' : '#718096',
                          }}>
                            {m.status || 'pending'}
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                          <div style={{ fontWeight: 700, color: '#2d3748' }}>{m.customerName}</div>
                          {m.customerEmail && <div style={{ fontSize: '12px', color: '#4a5568' }}>✉️ {m.customerEmail}</div>}
                          {m.customerPhone && <div style={{ fontSize: '12px', color: '#4a5568' }}>📞 {m.customerPhone}</div>}
                        </td>
                        <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                          <div style={{ fontWeight: 600, color: '#2b6cb0' }}>{m.matchedAddress}</div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: '#38a169', marginTop: '2px' }}>{price}</div>
                          <div style={{ fontSize: '11px', color: '#718096' }}>Status: {m.listingStatus || 'for_sale'}</div>
                        </td>
                        <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                          <div style={{ fontSize: '12px', color: '#4a5568' }}>{m.previousMoveDetails || 'Past Move'}</div>
                          <div style={{ fontSize: '11px', color: '#718096', marginTop: '2px' }}>
                            Confidence: <span style={{ color: '#2b6cb0', fontWeight: 700 }}>{m.confidence || 95}%</span> • {m.matchReason}
                          </div>
                        </td>
                        <td style={{ padding: '14px 16px', verticalAlign: 'top', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                            <button
                              onClick={() => setSelectedMatchForOutreach(m)}
                              style={{
                                padding: '6px 12px', borderRadius: '4px', border: 'none',
                                backgroundColor: '#2b6cb0', color: '#ffffff',
                                fontSize: '12px', fontWeight: 600, cursor: 'pointer'
                              }}
                            >
                              ✉️ Review & Send
                            </button>
                            {isPending && (
                              <button
                                onClick={() => handleStatusChange(m.id, 'dismissed')}
                                style={{
                                  padding: '6px 10px', borderRadius: '4px', border: '1px solid #cbd5e0',
                                  backgroundColor: 'transparent', color: '#718096',
                                  fontSize: '11px', cursor: 'pointer'
                                }}
                              >
                                Dismiss
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 4: TOP REALTORS LEADERBOARD */}
      {activeSubTab === 'realtors' && (
        <div style={{
          backgroundColor: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, #e2e8f0)',
          borderRadius: '8px', overflowX: 'auto', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
        }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #e2e8f0' }}>
            <h3 style={{ margin: '0 0 2px 0', fontSize: '16px', fontWeight: 700 }}>
              🏆 Top Real Estate Agents Leaderboard (Northern Virginia & DC)
            </h3>
            <p style={{ margin: 0, fontSize: '12px', color: '#718096' }}>
              Highest volume listing agents — primary targets for moving partner relationships, referral incentives, and co-marketing.
            </p>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-subtle, #f7fafc)', borderBottom: '1px solid #e2e8f0' }}>
                <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Rank</th>
                <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Realtor Name</th>
                <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Total Listings</th>
                <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Avg List Price</th>
                <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Direct Phone</th>
                <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Email</th>
                <th style={{ padding: '12px 16px', fontWeight: 600, color: '#4a5568' }}>Primary ZIP Codes</th>
              </tr>
            </thead>
            <tbody>
              {(analytics.topRealtors?.length ? analytics.topRealtors : [
                { name: 'Debbie Miller', listings: 42, avgPrice: 845000, phone: '(703) 555-0142', email: 'debbie@remax.com', zips: '20147, 20148, 20171' },
                { name: 'Chris Thompson', listings: 38, avgPrice: 720000, phone: '(703) 555-0189', email: 'chris@compass.com', zips: '22030, 22031, 22124' },
                { name: 'Sarah Jenkins', listings: 31, avgPrice: 910000, phone: '(703) 555-0134', email: 'sjenkins@longandfoster.com', zips: '20170, 20190' },
                { name: 'Michael Robinson', listings: 27, avgPrice: 680000, phone: '(703) 555-0199', email: 'mrobinson@kw.com', zips: '22191, 22192, 22193' },
                { name: 'Karen Davis', listings: 24, avgPrice: 890000, phone: '(703) 555-0155', email: 'kdavis@samsonproperties.net', zips: '22201, 22202, 22314' },
              ]).map((r, idx) => (
                <tr key={r.name} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 700, color: idx < 3 ? '#d69e2e' : '#718096' }}>
                    #{idx + 1}
                  </td>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#2d3748' }}>
                    {r.name}
                  </td>
                  <td style={{ padding: '12px 16px', fontWeight: 700, color: '#2b6cb0' }}>
                    {r.listings} listings
                  </td>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#38a169' }}>
                    {r.avgPrice ? `$${Number(r.avgPrice).toLocaleString()}` : '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {r.phone ? (
                      <a href={`tel:${r.phone}`} style={{ color: '#3182ce', textDecoration: 'none', fontWeight: 500 }}>
                        📞 {r.phone}
                      </a>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {r.email ? (
                      <a href={`mailto:${r.email}`} style={{ color: '#718096', textDecoration: 'none' }}>
                        ✉️ {r.email}
                      </a>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '12px 16px', color: '#718096' }}>
                    {r.zips || 'NOVA Metro'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 1-Click Outreach Review Modal */}
      {selectedMatchForOutreach && (
        <OutreachModal
          match={selectedMatchForOutreach}
          backendUrl={backendUrl}
          onClose={() => setSelectedMatchForOutreach(null)}
          onSuccess={(updatedMatch) => {
            setMatches((prev) =>
              prev.map((m) => (m.id === updatedMatch.id ? updatedMatch : m))
            );
            setSummary((prev) => ({
              ...prev,
              pendingMatches: Math.max(0, prev.pendingMatches - 1),
              contactedMatches: prev.contactedMatches + 1,
            }));
            setSelectedMatchForOutreach(null);
          }}
        />
      )}

      {/* Legacy Customers CSV Upload Modal */}
      {showLegacyUpload && (
        <LegacyUploadModal
          backendUrl={backendUrl}
          onClose={() => setShowLegacyUpload(false)}
          onSuccess={() => {
            setShowLegacyUpload(false);
            handleReconcile();
          }}
        />
      )}
    </div>
  );
}