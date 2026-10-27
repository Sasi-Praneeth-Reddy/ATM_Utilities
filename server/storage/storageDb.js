/**
 * server/storage/storageDb.js
 *
 * Dedicated Firestore access layer for Self-Storage Tracking & MLS Benchmarks.
 * Migrated from SQLite / AWS EC2 into Firebase Firestore.
 *
 * Collections:
 *  - `storageFacilities`: Storage facilities (Google Place ID, name, brand, address, phone, etc.)
 *  - `storagePricing`: Pricing snapshots per unit size and date
 *  - `storagePromotions`: Active facility discounts & promotions
 *  - `mlsBenchmarks`: NVAR & Bright MLS historical benchmark datasets
 *  - `mlsMarketData`: Housing market statistics per ZIP code
 */

const { db: fs } = require('../firestore');

const facilitiesCol = fs.collection('storageFacilities');
const pricingCol = fs.collection('storagePricing');
const promotionsCol = fs.collection('storagePromotions');
const benchmarksCol = fs.collection('mlsBenchmarks');
const mlsMarketCol = fs.collection('mlsMarketData');
const systemCol = fs.collection('system');

/* ---------------------------------------------------------------------------------------------
 * Cost controls (added 2026-10-27). The pricing collection holds ~42K snapshots, so reading (even a
 * "sample" of) it on every tab view is wasteful and, worse, gave wrong numbers (an arbitrary first
 * 400-600 documents). Now:
 *  - Small collections (facilities, benchmarks) are cached in memory for 10 minutes.
 *  - KPIs and the "latest pricing" table are computed over ALL snapshots at most once a day (or
 *    after new pricing is ingested) and stored in ONE document, system/storageSummary. Reading it
 *    costs 1 read.
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
  await systemCol.doc('storageSummary').set({ dirty: true }, { merge: true });
}

// ================================================================
// FACILITIES
// ================================================================

async function getFacilities({ brand, zipCode } = {}) {
  const all = await memoized('facilities', async () => {
    const snap = await facilitiesCol.get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return list;
  });
  return all.filter((f) => (!brand || f.brand === brand) && (!zipCode || f.zipCode === zipCode));
}

async function getFacility(id) {
  const doc = await facilitiesCol.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function upsertFacilities(facilities = []) {
  if (!facilities.length) return { count: 0 };
  const now = new Date().toISOString();
  let count = 0;

  for (let i = 0; i < facilities.length; i += 400) {
    const chunk = facilities.slice(i, i + 400);
    const batch = fs.batch();

    for (const f of chunk) {
      const docId = f.googlePlaceId || f.google_place_id || String(f.id);
      if (!docId) continue;
      const ref = facilitiesCol.doc(docId);
      const data = {
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
        lastUpdated: now,
      };
      batch.set(ref, data, { merge: true });
      count++;
    }
    await batch.commit();
  }
  return { count };
}

// ================================================================
// PRICING SNAPSHOTS
// ================================================================

/** Latest scrape's cheapest listed rate per facility + unit size, from the stored summary (1 read). */
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
  let query = pricingCol
    .where('facilityId', '==', facilityId)
    .where('unitSize', '==', unitSize)
    .where('scrapedAt', '>=', cutoff);

  const snap = await query.get();
  const list = snap.docs.map((d) => d.data());
  list.sort((a, b) => (a.scrapedAt || '').localeCompare(b.scrapedAt || ''));
  return list;
}

async function insertPricingSnapshots(snapshots = []) {
  if (!snapshots.length) return { count: 0 };
  const now = new Date().toISOString();
  let count = 0;

  for (let i = 0; i < snapshots.length; i += 400) {
    const chunk = snapshots.slice(i, i + 400);
    const batch = fs.batch();

    for (const s of chunk) {
      const docId = `price_${s.facilityId || s.facility_id}_${s.unitSize || s.unit_size}_${Date.now()}_${count}`;
      const ref = pricingCol.doc(docId);
      const data = {
        facilityId: String(s.facilityId || s.facility_id),
        unitSize: s.unitSize || s.unit_size || '10x10',
        unitType: s.unitType || s.unit_type || 'Standard',
        streetRate: Number(s.streetRate || s.street_rate) || null,
        webRate: Number(s.webRate || s.web_rate) || null,
        availability: s.availability || 'available',
        source: s.source || 'scraper',
        scrapedAt: s.scrapedAt || s.scraped_at || now,
      };
      batch.set(ref, data);
      count++;
    }
    await batch.commit();
  }
  return { count };
}

// ================================================================
// STORAGE KPIS & MARKET SHARE
// ================================================================

const KPI_UNIT_SIZES = ['5x5', '10x10', '10x15', '10x20'];
const KPI_DEFAULT_RATES = { '5x5': 78, '10x10': 152, '10x15': 218, '10x20': 289 };

/** Full pass over every pricing snapshot (~42K reads) — only run from getStorageSummary(). */
async function computeStorageSummary() {
  const [facSnap, priceSnap] = await Promise.all([
    facilitiesCol.get(),
    pricingCol.select('facilityId', 'unitSize', 'unitType', 'availability', 'streetRate', 'webRate', 'scrapedAt', 'source').get(),
  ]);

  // "Latest" = each facility's most recent scrape day.
  const latestDay = new Map();
  let lastScraped = '';
  for (const doc of priceSnap.docs) {
    const r = doc.data();
    const at = String(r.scrapedAt || '');
    const day = at.slice(0, 10);
    const fid = String(r.facilityId);
    if (day > (latestDay.get(fid) || '')) latestDay.set(fid, day);
    if (at > lastScraped) lastScraped = at;
  }

  const sums = {};
  const best = new Map(); // `${facilityId}|${unitSize}` -> cheapest row of the latest scrape
  for (const doc of priceSnap.docs) {
    const r = doc.data();
    const fid = String(r.facilityId);
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
    totalFacilities: facSnap.size,
    activeSnapshots: priceSnap.size,
    avgRates,
    lastScraped,
    latestPricingJson: JSON.stringify([...best.values()]),
  };
}

let summaryInflight = null;
let summaryParsed = { computedAt: null, value: null };
async function getStorageSummary() {
  const ref = systemCol.doc('storageSummary');
  let data = null;
  const snap = await ref.get();
  if (snap.exists) {
    const d = snap.data();
    if (d.computedAt && !d.dirty && Date.now() - Date.parse(d.computedAt) < SUMMARY_TTL_MS) data = d;
  }
  if (!data) {
    if (!summaryInflight) {
      summaryInflight = (async () => {
        const fresh = await computeStorageSummary();
        await ref.set(fresh);
        return fresh;
      })().finally(() => { summaryInflight = null; });
    }
    data = await summaryInflight;
  }
  if (summaryParsed.computedAt !== data.computedAt) {
    summaryParsed = { computedAt: data.computedAt, value: { ...data, latestPricing: JSON.parse(data.latestPricingJson || '[]') } };
  }
  return { ...summaryParsed.value, latestPricing: [...summaryParsed.value.latestPricing] };
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
    const snap = await benchmarksCol.get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.periodDate || '').localeCompare(a.periodDate || ''));
    return list;
  });
  return all.filter((b) => (!source || b.source === source) && (!region || b.region === region));
}

async function upsertMlsBenchmarks(benchmarks = []) {
  if (!benchmarks.length) return { count: 0 };
  let count = 0;

  for (let i = 0; i < benchmarks.length; i += 400) {
    const chunk = benchmarks.slice(i, i + 400);
    const batch = fs.batch();

    for (const b of chunk) {
      const docId = `bm_${b.source || 'NVAR'}_${b.periodDate || b.period_date}_${(b.region || 'NOVA').replace(/\s+/g, '_')}`;
      const ref = benchmarksCol.doc(docId);
      const data = {
        source: b.source || 'NVAR',
        periodType: b.periodType || b.period_type || 'monthly',
        periodDate: b.periodDate || b.period_date,
        year: Number(b.year) || null,
        month: Number(b.month) || null,
        region: b.region || 'Northern Virginia',
        newListings: Number(b.newListings || b.new_listings) || 0,
        activeListings: Number(b.activeListings || b.active_listings) || 0,
        closedSales: Number(b.closedSales || b.closed_sales) || 0,
        pendingSales: Number(b.pendingSales || b.pending_sales) || 0,
        medianDaysOnMarket: Number(b.medianDaysOnMarket || b.median_days_on_market) || 0,
        avgClosePrice: Number(b.avgClosePrice || b.avg_close_price) || 0,
        medianClosePrice: Number(b.medianClosePrice || b.median_close_price) || 0,
        closeToListRatio: Number(b.closeToListRatio || b.close_to_list_ratio) || 100.0,
      };
      batch.set(ref, data, { merge: true });
      count++;
    }
    await batch.commit();
  }
  return { count };
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
