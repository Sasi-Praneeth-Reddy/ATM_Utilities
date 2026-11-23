/**
 * server/storage/storageDb.js
 *
 * Data access layer for Self-Storage Tracking & MLS Benchmarks, backed by AWS DynamoDB (see ../awsStore.js
 * and docs/AWS-DATA.md). Before that: Firebase SQL Connect / Cloud SQL (2026-10-28 to 2026-11), Firestore, and
 * before that SQLite on AWS EC2.
 *
 * Tables (defined in ../awsStore.js): StorageFacility, StoragePricing, MlsBenchmark, AppState.
 */

const store = require('../awsStore');

/* ---------------------------------------------------------------------------------------------
 * Caching. Small tables (facilities, benchmarks) are cached in memory for 10 minutes. KPIs and the
 * "latest pricing" table are computed over ALL pricing snapshots at most once a day (or after new
 * pricing is ingested) and stored in the AppState table.
 * ------------------------------------------------------------------------------------------- */
const MEMO_TTL_MS = 10 * 60 * 1000;
const memo = new Map();
async function memoized(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}
function clearStorageCache() {
  memo.clear();
}
async function markStorageSummaryDirty() {
  await store.mergeState('storageSummary', { dirty: true });
}


// ================================================================
// SCRAPER DATA CLEAN-UP
// The StorageCafe scraper sends unit sizes like "10' x 15'" and facilities whose city/state/brand are
// "Unknown"/"Independent" with the real values only inside the name ("Public Storage, Falls Church, VA 22042").
// Both are normalised here, on write and on read, so old and new rows behave the same.
// ================================================================

/** "10' x 15'", "15 x 10", "10X15" -> "10x15" (smaller side first, so 5x10 and 10x5 are one size). */
function normalizeUnitSize(raw) {
  const m = /(\d+(?:\.\d+)?)\s*['"′]?\s*[x×*]\s*(\d+(?:\.\d+)?)/i.exec(String(raw || ''));
  if (!m) return String(raw || '').trim() || '10x10';
  const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
  return `${a}x${b}`;
}

const KNOWN_BRANDS = [
  ['Public Storage', /public storage/i], ['Extra Space Storage', /extra space/i], ['CubeSmart', /cubesmart|cube smart/i],
  ['Life Storage', /life storage/i], ['U-Haul', /u-?haul/i], ['StorageMart', /storagemart/i], ['SmartStop', /smartstop/i],
  ['Simply Self Storage', /simply self/i], ['iStorage', /istorage/i], ['National Storage Affiliates', /national storage/i],
];
const isUnknown = (v) => !v || /^unknown$/i.test(String(v).trim());

/** Fill in city/state/brand from a name like "Public Storage, Falls Church, VA 22042" when the fields say Unknown. */
function cleanFacilityFields(f) {
  const out = { ...f };
  const m = /,\s*([^,]+?),\s*([A-Z]{2})\s+(\d{5})\s*$/.exec(String(f.name || ''));
  if (isUnknown(out.city)) out.city = m ? m[1].trim() : '';
  if (isUnknown(out.state)) out.state = m ? m[2] : '';
  if (isUnknown(out.zipCode) && m) out.zipCode = m[3];
  for (const k of ['address', 'phone']) if (isUnknown(out[k])) out[k] = '';
  if (!out.brand || out.brand === 'Independent') {
    const hit = KNOWN_BRANDS.find(([, re]) => re.test(out.name || ''));
    out.brand = hit ? hit[0] : 'Independent';
  }
  return out;
}

// ================================================================
// FACILITIES
// ================================================================

function rowToFacility(r) {
  return cleanFacilityFields({
    id: r.facilityId,
    name: r.name || '',
    brand: r.brand || '',
    address: r.address || '',
    city: r.city || '',
    state: r.state || '',
    zipCode: r.zipCode || '',
    lat: r.lat ?? null,
    lon: r.lon ?? null,
    phone: r.phone || '',
    website: r.website || '',
  });
}

async function getFacilities({ brand, zipCode } = {}) {
  const all = await memoized('facilities', async () => {
    const rows = await store.scan('StorageFacility');
    const list = rows.map(rowToFacility);
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return list;
  });
  return all.filter((f) => (!brand || f.brand === brand) && (!zipCode || f.zipCode === zipCode));
}

async function getFacility(id) {
  const row = await store.getItem('StorageFacility', String(id));
  return row ? rowToFacility(row) : null;
}

async function upsertFacilities(facilities = []) {
  if (!facilities.length) return { count: 0 };
  const byId = new Map();
  for (const f of facilities) {
    const facilityId = f.googlePlaceId || f.google_place_id || (f.id !== undefined && f.id !== null ? String(f.id) : '');
    if (!facilityId) continue;
    byId.set(facilityId, cleanFacilityFields({
      facilityId,
      name: f.name || '',
      brand: f.brand || 'Independent',
      address: f.address || '',
      city: f.city || '',
      state: f.state || 'VA',
      zipCode: f.zipCode || f.zip_code || '',
      lat: Number(f.lat) || null,
      lon: Number(f.lon) || null,
      phone: f.phone || '',
      website: f.website || '',
    }));
  }
  const rows = [...byId.values()];
  await store.upsertMany('StorageFacility', rows);
  return { count: rows.length };
}

// ================================================================
// PRICING SNAPSHOTS
// ================================================================

/** Latest scrape's cheapest listed rate per facility + unit size, from the stored summary. */
async function getLatestPricing({ unitSize, facilityId } = {}) {
  const summary = await getStorageSummary();
  const rows = summary.latestPricing.filter(
    (r) => (!unitSize || r.unitSize === unitSize) && (!facilityId || String(r.facilityId) === String(facilityId))
  );
  rows.sort((a, b) => (a.webRate || 0) - (b.webRate || 0));
  return rows;
}

async function getPricingHistory(facilityId, unitSize, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const resolved = (await resolveFacilityId(facilityId)) || String(facilityId);
  const rows = await store.pricingHistory(resolved, unitSize, cutoff);
  return rows.map((r) => ({
    facilityId: r.facilityId || resolved,
    unitSize: r.unitSize,
    unitType: r.unitType || '',
    streetRate: r.streetRate ?? null,
    webRate: r.webRate ?? null,
    availability: r.availability || '',
    source: r.source || '',
    scrapedAt: r.scrapedAt,
  }));
}

/** Old scraper IDs were SQLite integers; the table now keys facilities by Google Place ID. */
async function resolveFacilityId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = String(raw);
  const facilities = await getFacilities();
  if (facilities.some((f) => f.id === id)) return id;
  const map = await memoized('facilityIdMap', async () => (await store.getState('facilityIdMap')) || {});
  return map[id] || null;
}

async function insertPricingSnapshots(snapshots = []) {
  if (!snapshots.length) return { count: 0, skipped: 0 };
  const now = new Date().toISOString();
  const rows = [];
  let skipped = 0;
  let n = 0;

  for (const s of snapshots) {
    const facilityId = await resolveFacilityId(s.facilityId || s.facility_id);
    if (!facilityId) { skipped++; continue; }
    const unitSize = normalizeUnitSize(s.unitSize || s.unit_size || '10x10');
    rows.push({
      // A scraper-supplied snapshotKey makes re-running the same day's job idempotent (same key = same row).
      priceId: s.snapshotKey ? `price_${facilityId}_${s.snapshotKey}` : `price_${facilityId}_${unitSize}_${Date.now()}_${n++}`,
      facilityId,
      unitSize,
      unitType: s.unitType || s.unit_type || 'Standard',
      streetRate: Math.round(Number(s.streetRate || s.street_rate)) || null,
      webRate: Math.round(Number(s.webRate || s.web_rate)) || null,
      availability: s.availability || 'available',
      source: s.source || 'scraper',
      scrapedAt: store.isoTs(s.scrapedAt || s.scraped_at) || now,
    });
  }
  if (rows.length) await store.upsertMany('StoragePricing', rows);
  if (skipped) console.warn(`[storageDb] ${skipped} pricing snapshots skipped: unknown facility id.`);
  return { count: rows.length, skipped };
}

// ================================================================
// STORAGE KPIS & MARKET SHARE
// ================================================================

const KPI_UNIT_SIZES = ['5x5', '10x10', '10x15', '10x20'];
const KPI_DEFAULT_RATES = { '5x5': 78, '10x10': 152, '10x15': 218, '10x20': 289 };

const SUMMARY_WINDOW_DAYS = 30;

/** Pass over the most recent 30 days of pricing snapshots (history keeps growing daily, so we never
 * read all of it) - only run from getStorageSummary(). */
async function computeStorageSummary() {
  const newestAt = await store.newestPricingAt();
  const since = new Date((newestAt ? Date.parse(newestAt) : Date.now()) - SUMMARY_WINDOW_DAYS * 86400000).toISOString();
  const facilities = await store.scan('StorageFacility', { project: ['facilityId'] });

  // Stream the price rows page by page and keep only a running aggregate per facility + unit size
  // (its most recent scrape day), so memory stays small however much history has piled up.
  let activeSnapshots = 0;
  let lastScraped = '';
  const agg = new Map(); // `${facilityId}|${unitSize}` -> { day, sum, count, best }
  await store.pricingSince(since, (rows) => {
    for (const r of rows) {
      activeSnapshots += 1;
      const at = String(r.scrapedAt || '');
      if (at > lastScraped) lastScraped = at;
      if (!r.webRate || !r.facilityId) continue;
      const day = at.slice(0, 10);
      const fid = String(r.facilityId);
      const size = normalizeUnitSize(r.unitSize); // rows saved before the clean-up still say "10' x 15'"
      const key = `${fid}|${size}`;
      let a = agg.get(key);
      if (!a || day > a.day) { a = { day, sum: 0, count: 0, best: null }; agg.set(key, a); }
      if (day < a.day) continue;
      a.sum += r.webRate;
      a.count += 1;
      if (!a.best || r.webRate < a.best.webRate) {
        a.best = {
          id: key.replace('|', '_'),
          facilityId: fid,
          unitSize: size,
          unitType: r.unitType || '',
          availability: r.availability || '',
          streetRate: r.streetRate ?? null,
          webRate: r.webRate,
          scrapedAt: at,
          source: r.source || '',
        };
      }
    }
  });

  const sums = {};
  const best = [];
  for (const [key, a] of agg) {
    const sz = key.slice(key.indexOf('|') + 1);
    const acc = (sums[sz] ||= { sum: 0, count: 0 });
    acc.sum += a.sum;
    acc.count += a.count;
    best.push(a.best);
  }

  const avgRates = {};
  for (const sz of KPI_UNIT_SIZES) {
    avgRates[sz] = sums[sz] && sums[sz].count ? Math.round(sums[sz].sum / sums[sz].count) : KPI_DEFAULT_RATES[sz];
  }

  // Compact roll-ups for the dashboard: one row per city + unit size and per brand + unit size.
  const byId = new Map((await getFacilities()).map((f) => [String(f.id), f]));
  const cityAcc = new Map();
  const brandAcc = new Map();
  const bump = (m, key, base, rate) => {
    const a = m.get(key) || { ...base, sum: 0, n: 0, min: Infinity, max: 0 };
    a.sum += rate; a.n += 1; a.min = Math.min(a.min, rate); a.max = Math.max(a.max, rate);
    m.set(key, a);
  };
  for (const b of best) {
    const f = byId.get(String(b.facilityId));
    if (!f || !b.webRate) continue;
    if (f.city) bump(cityAcc, `${f.city}|${f.state}|${b.unitSize}`, { city: f.city, state: f.state, unitSize: b.unitSize }, b.webRate);
    bump(brandAcc, `${f.brand || 'Independent'}|${b.unitSize}`, { brand: f.brand || 'Independent', unitSize: b.unitSize }, b.webRate);
  }
  const roll = (m) => [...m.values()].map(({ sum, n, min, max, ...k }) => ({ ...k, avg: Math.round(sum / n), min, max, facilities: n }));

  return {
    computedAt: new Date().toISOString(),
    dirty: false,
    totalFacilities: facilities.length,
    activeSnapshots,
    avgRates,
    lastScraped,
    cityRates: roll(cityAcc),
    brandRates: roll(brandAcc),
    latestPricing: best,
  };
}

const CITY_HISTORY_DAYS = 400;
/** Small daily history of city averages, kept in one document, so trends do not need the raw price rows. */
async function recordCityHistory(summary) {
  if (!summary.lastScraped || !(summary.cityRates || []).length) return;
  const day = String(summary.lastScraped).slice(0, 10);
  const hist = (await store.getState('storageCityHistory')) || {};
  const entry = {};
  for (const r of summary.cityRates) entry[`${r.city}|${r.state}|${r.unitSize}`] = [r.avg, r.facilities];
  hist[day] = entry;
  const days = Object.keys(hist).sort();
  while (days.length > CITY_HISTORY_DAYS) delete hist[days.shift()];
  await store.setState('storageCityHistory', hist);
}

async function getStorageOverview() {
  const s = await getStorageSummary();
  return {
    totalFacilities: s.totalFacilities,
    avgRates: s.avgRates,
    lastScraped: s.lastScraped,
    cityRates: s.cityRates || [],
    brandRates: s.brandRates || [],
  };
}

async function getCityHistory({ city, state, unitSize = '10x10' } = {}) {
  const hist = (await store.getState('storageCityHistory')) || {};
  const key = city ? `${city}|${state || ''}|${unitSize}` : null;
  return Object.keys(hist).sort().map((day) => {
    if (key) { const v = hist[day][key]; return v ? { day, avg: v[0], facilities: v[1] } : null; }
    let sum = 0, n = 0;
    for (const [k, v] of Object.entries(hist[day])) if (k.endsWith(`|${unitSize}`)) { sum += v[0] * v[1]; n += v[1]; }
    return n ? { day, avg: Math.round(sum / n), facilities: n } : null;
  }).filter(Boolean);
}

let summaryInflight = null;
let summaryCache = { computedAt: null, value: null };

/** Recompute the summary and store it. Slow (scans the recent price rows) - called by the scraper after
 * its upload (POST /api/storage/summary/refresh) and only on a page load if nothing has ever been stored. */
async function refreshStorageSummary() {
  if (!summaryInflight) {
    summaryInflight = (async () => {
      const fresh = await computeStorageSummary();
      await store.setState('storageSummary', fresh);
      try { await recordCityHistory(fresh); } catch (e) { console.error('recordCityHistory failed:', e.message); }
      return fresh;
    })().finally(() => { summaryInflight = null; });
  }
  return summaryInflight;
}

async function getStorageSummary() {
  // Page loads read the stored summary even if it is a little stale ("dirty"): a fast answer now beats a
  // 30-second scan. Fresh data arrives when the scraper triggers a refresh.
  let data = await store.getState('storageSummary');
  if (!data || !data.computedAt) data = await refreshStorageSummary();
  if (summaryCache.computedAt !== data.computedAt) summaryCache = { computedAt: data.computedAt, value: data };
  return { ...summaryCache.value, latestPricing: [...(summaryCache.value.latestPricing || [])] };
}

async function getStorageKpis() {
  const sum = await getStorageSummary();
  return {
    totalFacilities: sum.totalFacilities,
    activeSnapshots: sum.activeSnapshots,
    avgRates: sum.avgRates,
    lastScraped: sum.lastScraped || new Date().toISOString(),
  };
}

async function getMarketShare() {
  const facilities = await getFacilities();
  const counts = {};
  facilities.forEach((f) => {
    const brand = f.brand || 'Independent';
    counts[brand] = (counts[brand] || 0) + 1;
  });

  const total = facilities.length || 1;
  return Object.entries(counts).map(([brand, count]) => ({
    brand,
    count,
    sharePct: Math.round((count / total) * 100),
  }));
}

// ================================================================
// MLS BENCHMARKS (NVAR & BRIGHT MLS)
// ================================================================

async function getMlsBenchmarks({ source, region } = {}) {
  const all = await memoized('benchmarks', async () => {
    const rows = await store.scan('MlsBenchmark');
    const list = rows.map((r) => ({ id: r.benchmarkId, ...r, benchmarkId: undefined }));
    list.sort((a, b) => (b.periodDate || '').localeCompare(a.periodDate || ''));
    return list;
  });
  return all.filter((b) => (!source || b.source === source) && (!region || b.region === region));
}

async function upsertMlsBenchmarks(benchmarks = []) {
  if (!benchmarks.length) return { count: 0 };
  const byId = new Map();

  for (const b of benchmarks) {
    const periodDate = store.dateOnly(b.periodDate || b.period_date);
    if (!periodDate) continue;
    const benchmarkId = `bm_${b.source || 'NVAR'}_${periodDate}_${(b.region || 'NOVA').replace(/\s+/g, '_')}`;
    byId.set(benchmarkId, {
      benchmarkId,
      source: b.source || 'NVAR',
      periodType: b.periodType || b.period_type || 'monthly',
      periodDate,
      year: Number(b.year) || null,
      month: Number(b.month) || null,
      region: b.region || 'Northern Virginia',
      newListings: Math.round(Number(b.newListings || b.new_listings)) || 0,
      activeListings: Math.round(Number(b.activeListings || b.active_listings)) || 0,
      closedSales: Math.round(Number(b.closedSales || b.closed_sales)) || 0,
      pendingSales: Math.round(Number(b.pendingSales || b.pending_sales)) || 0,
      medianDaysOnMarket: Math.round(Number(b.medianDaysOnMarket || b.median_days_on_market)) || 0,
      avgClosePrice: Math.round(Number(b.avgClosePrice || b.avg_close_price)) || 0,
      medianClosePrice: Math.round(Number(b.medianClosePrice || b.median_close_price)) || 0,
      closeToListRatio: Number(b.closeToListRatio || b.close_to_list_ratio) || 100.0,
    });
  }
  const rows = [...byId.values()];
  await store.upsertMany('MlsBenchmark', rows);
  return { count: rows.length };
}

/** Writers drop the in-memory caches; pricing/facility writes also flag the stored summary for recompute. */
function afterWrite(fn, { dirtySummary = false } = {}) {
  return async function (...args) {
    const result = await fn.apply(this, args);
    clearStorageCache();
    if (dirtySummary) {
      try { await markStorageSummaryDirty(); } catch (e) { console.error('markStorageSummaryDirty failed:', e.message); }
    }
    return result;
  };
}
const upsertFacilitiesW = afterWrite(upsertFacilities, { dirtySummary: true });
const insertPricingSnapshotsW = afterWrite(insertPricingSnapshots, { dirtySummary: true });
const upsertMlsBenchmarksW = afterWrite(upsertMlsBenchmarks);

module.exports = {
  getFacilities,
  getFacility,
  upsertFacilities: upsertFacilitiesW,
  getLatestPricing,
  getPricingHistory,
  insertPricingSnapshots: insertPricingSnapshotsW,
  getStorageKpis,
  refreshStorageSummary,
  getStorageOverview,
  getCityHistory,
  getMarketShare,
  getMlsBenchmarks,
  upsertMlsBenchmarks: upsertMlsBenchmarksW,
  // exposed for tests only
  _computeStorageSummary: computeStorageSummary,
};
