/**
 * server/storage/storageDb.js
 *
 * Data access layer for Self-Storage Tracking & MLS Benchmarks, backed by Firebase SQL Connect
 * (Cloud SQL for PostgreSQL) since 2026-10-28. Previously Firestore, and before that SQLite on AWS EC2.
 *
 * Tables (see /dataconnect/schema/schema.gql): StorageFacility, StoragePricing, MlsBenchmark, AppState.
 */

const sql = require('../sqlconnect');

/* ---------------------------------------------------------------------------------------------
 * Caching. Small tables (facilities, benchmarks) are cached in memory for 10 minutes. KPIs and the
 * "latest pricing" table are computed over ALL pricing snapshots at most once a day (or after new
 * pricing is ingested) and stored in the AppState table.
 * ------------------------------------------------------------------------------------------- */
const MEMO_TTL_MS = 10 * 60 * 1000;
const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;
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
  await sql.mergeState('storageSummary', { dirty: true });
}

// ================================================================
// FACILITIES
// ================================================================

const FACILITY_SELECTION = 'facilityId name brand address city state zipCode lat lon phone website';
function rowToFacility(r) {
  return {
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
  };
}

async function getFacilities({ brand, zipCode } = {}) {
  const all = await memoized('facilities', async () => {
    const rows = await sql.pageAll('storageFacilities', 'facilityId', FACILITY_SELECTION);
    const list = rows.map(rowToFacility);
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return list;
  });
  return all.filter((f) => (!brand || f.brand === brand) && (!zipCode || f.zipCode === zipCode));
}

async function getFacility(id) {
  const data = await sql.read(`query F($id: String!) { storageFacility(key: {facilityId: $id}) { ${FACILITY_SELECTION} } }`, { id: String(id) });
  return data.storageFacility ? rowToFacility(data.storageFacility) : null;
}

async function upsertFacilities(facilities = []) {
  if (!facilities.length) return { count: 0 };
  const byId = new Map();
  for (const f of facilities) {
    const facilityId = f.googlePlaceId || f.google_place_id || (f.id !== undefined && f.id !== null ? String(f.id) : '');
    if (!facilityId) continue;
    byId.set(facilityId, {
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
    });
  }
  const rows = [...byId.values()];
  await sql.upsertMany('StorageFacility', 'storageFacility_upsertMany', rows);
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
  const data = await sql.read(
    `query H($f: String!, $u: String!, $c: Timestamp!) {
       storagePricings(limit: 5000, orderBy: {scrapedAt: ASC},
         where: {facility: {facilityId: {eq: $f}}, unitSize: {eq: $u}, scrapedAt: {ge: $c}}) {
         priceId facility { facilityId } unitSize unitType streetRate webRate availability source scrapedAt
       }
     }`,
    { f: resolved, u: unitSize, c: cutoff }
  );
  return (data.storagePricings || []).map((r) => ({
    facilityId: r.facility ? r.facility.facilityId : resolved,
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
  const map = await memoized('facilityIdMap', async () => (await sql.getState('facilityIdMap')) || {});
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
    const unitSize = s.unitSize || s.unit_size || '10x10';
    rows.push({
      // A scraper-supplied snapshotKey makes re-running the same day's job idempotent (same key = same row).
      priceId: s.snapshotKey ? `price_${facilityId}_${s.snapshotKey}` : `price_${facilityId}_${unitSize}_${Date.now()}_${n++}`,
      facilityFacilityId: facilityId,
      unitSize,
      unitType: s.unitType || s.unit_type || 'Standard',
      streetRate: Math.round(Number(s.streetRate || s.street_rate)) || null,
      webRate: Math.round(Number(s.webRate || s.web_rate)) || null,
      availability: s.availability || 'available',
      source: s.source || 'scraper',
      scrapedAt: sql.isoTs(s.scrapedAt || s.scraped_at) || now,
    });
  }
  if (rows.length) await sql.upsertMany('StoragePricing', 'storagePricing_upsertMany', rows);
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
  const newest = await sql.read('query N { storagePricings(limit: 1, orderBy: {scrapedAt: DESC}) { scrapedAt } }');
  const newestAt = newest.storagePricings && newest.storagePricings[0] ? newest.storagePricings[0].scrapedAt : null;
  const since = new Date((newestAt ? Date.parse(newestAt) : Date.now()) - SUMMARY_WINDOW_DAYS * 86400000).toISOString();
  const [facilities, prices] = await Promise.all([
    sql.pageAll('storageFacilities', 'facilityId', 'facilityId'),
    sql.pageAll('storagePricings', 'priceId', 'facility { facilityId } unitSize unitType availability streetRate webRate scrapedAt source', {
      where: 'scrapedAt: {ge: $since}', varDefs: ', $since: Timestamp!', vars: { since },
    }),
  ]);

  // "Latest" = each facility's most recent scrape day.
  const latestDay = new Map();
  let lastScraped = '';
  for (const r of prices) {
    const at = String(r.scrapedAt || '');
    const day = at.slice(0, 10);
    const fid = String(r.facility.facilityId);
    if (day > (latestDay.get(fid) || '')) latestDay.set(fid, day);
    if (at > lastScraped) lastScraped = at;
  }

  const sums = {};
  const best = new Map(); // `${facilityId}|${unitSize}` -> cheapest row of the latest scrape
  for (const r of prices) {
    const fid = String(r.facility.facilityId);
    if (String(r.scrapedAt || '').slice(0, 10) !== latestDay.get(fid) || !r.webRate) continue;
    const acc = (sums[r.unitSize] ||= { sum: 0, count: 0 });
    acc.sum += r.webRate;
    acc.count += 1;
    const key = `${fid}|${r.unitSize}`;
    const cur = best.get(key);
    if (!cur || r.webRate < cur.webRate) {
      best.set(key, {
        id: key.replace('|', '_'),
        facilityId: fid,
        unitSize: r.unitSize,
        unitType: r.unitType || '',
        availability: r.availability || '',
        streetRate: r.streetRate ?? null,
        webRate: r.webRate,
        scrapedAt: r.scrapedAt || '',
        source: r.source || '',
      });
    }
  }

  const avgRates = {};
  for (const sz of KPI_UNIT_SIZES) {
    avgRates[sz] = sums[sz] && sums[sz].count ? Math.round(sums[sz].sum / sums[sz].count) : KPI_DEFAULT_RATES[sz];
  }

  return {
    computedAt: new Date().toISOString(),
    dirty: false,
    totalFacilities: facilities.length,
    activeSnapshots: prices.length,
    avgRates,
    lastScraped,
    latestPricing: [...best.values()],
  };
}

let summaryInflight = null;
let summaryCache = { computedAt: null, value: null };
async function getStorageSummary() {
  let data = null;
  const stored = await sql.getState('storageSummary');
  if (stored && stored.computedAt && !stored.dirty && Date.now() - Date.parse(stored.computedAt) < SUMMARY_TTL_MS) {
    data = stored;
  }
  if (!data) {
    if (!summaryInflight) {
      summaryInflight = (async () => {
        const fresh = await computeStorageSummary();
        await sql.setState('storageSummary', fresh);
        return fresh;
      })().finally(() => { summaryInflight = null; });
    }
    data = await summaryInflight;
  }
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

const BENCH_SELECTION = 'benchmarkId region source periodType periodDate year month activeListings newListings closedSales pendingSales avgClosePrice medianClosePrice medianDaysOnMarket closeToListRatio';

async function getMlsBenchmarks({ source, region } = {}) {
  const all = await memoized('benchmarks', async () => {
    const rows = await sql.pageAll('mlsBenchmarks', 'benchmarkId', BENCH_SELECTION);
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
    const periodDate = sql.dateOnly(b.periodDate || b.period_date);
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
  await sql.upsertMany('MlsBenchmark', 'mlsBenchmark_upsertMany', rows);
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
  getMarketShare,
  getMlsBenchmarks,
  upsertMlsBenchmarks: upsertMlsBenchmarksW,
  // exposed for tests only
  _computeStorageSummary: computeStorageSummary,
};
