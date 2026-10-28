/**
 * server/storage/storageRouter.js
 *
 * Dedicated router for Self-Storage Tracking & Market Intelligence.
 * Fully encapsulated in the storage/ subfolder.
 */

const storageDb = require('./storageDb');
const { hasValidScraperKey } = require('../scraperAuth');

function sendJson(req, res, status, body) {
  const data = JSON.stringify(body);
  const origin = req.headers.origin;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  if (req.rawBody !== undefined) {
    if (!req.rawBody || !req.rawBody.length) return {};
    return JSON.parse(req.rawBody.toString('utf8'));
  }
  const raw = await readRequestBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

async function handleStorageRequest(req, res, url, currentUser) {
  const p = url.pathname;
  if (!p.startsWith('/api/storage')) return false;

  if (req.method === 'OPTIONS') {
    sendJson(req, res, 204, {});
    return true;
  }

  // The daily scraper (GitHub Actions) may push data with the x-api-key header; it can only use the
  // bulk write endpoints below, never read anything.
  const isScraperWrite = req.method === 'POST' && (p.endsWith('/bulk') || p === '/api/storage/summary/refresh') && hasValidScraperKey(req);

  // Auth requirement: storage tracking data visible to admin and dispatcher
  if (!isScraperWrite && (!currentUser || !['admin', 'dispatcher'].includes(currentUser.role))) {
    sendJson(req, res, 403, { error: 'Forbidden: Storage intelligence requires admin or dispatcher access' });
    return true;
  }

  // Bulk writes change shared market data, so they are admin-only (dispatchers can still read everything).
  if (req.method === 'POST' && !isScraperWrite && currentUser.role !== 'admin') {
    sendJson(req, res, 403, { error: 'Forbidden: changing storage data requires admin access' });
    return true;
  }

  // Browsers may reuse read responses for 2 minutes (data changes once a day), so tab switches and reloads are instant.
  if (req.method === 'GET') res.setHeader('Cache-Control', 'private, max-age=120');

  try {
    // GET /api/storage/facilities
    if (p === '/api/storage/facilities' && req.method === 'GET') {
      const brand = url.searchParams.get('brand') || undefined;
      const zipCode = url.searchParams.get('zipCode') || undefined;
      const list = await storageDb.getFacilities({ brand, zipCode });
      sendJson(req, res, 200, list);
      return true;
    }

    // GET /api/storage/overview - tiny city/brand roll-up (loads instantly, powers the dashboard's first view)
    if (p === '/api/storage/overview' && req.method === 'GET') {
      sendJson(req, res, 200, await storageDb.getStorageOverview());
      return true;
    }

    // GET /api/storage/city-history?city=&state=&unitSize= - daily average rate (market-wide when no city)
    if (p === '/api/storage/city-history' && req.method === 'GET') {
      sendJson(req, res, 200, await storageDb.getCityHistory({
        city: url.searchParams.get('city') || undefined,
        state: url.searchParams.get('state') || undefined,
        unitSize: url.searchParams.get('unitSize') || '10x10',
      }));
      return true;
    }

    // GET /api/storage/kpis
    if (p === '/api/storage/kpis' && req.method === 'GET') {
      const kpis = await storageDb.getStorageKpis();
      sendJson(req, res, 200, kpis);
      return true;
    }

    // GET /api/storage/pricing/latest
    if (p === '/api/storage/pricing/latest' && req.method === 'GET') {
      const unitSize = url.searchParams.get('unitSize') || undefined;
      const facilityId = url.searchParams.get('facilityId') || undefined;
      const pricing = await storageDb.getLatestPricing({ unitSize, facilityId });
      sendJson(req, res, 200, pricing);
      return true;
    }

    // GET /api/storage/price-history
    if (p === '/api/storage/price-history' && req.method === 'GET') {
      const facilityId = url.searchParams.get('facilityId');
      const unitSize = url.searchParams.get('unitSize') || '10x10';
      const days = Number(url.searchParams.get('days')) || 30;
      if (!facilityId) {
        sendJson(req, res, 400, { error: 'facilityId is required' });
        return true;
      }
      const history = await storageDb.getPricingHistory(facilityId, unitSize, days);
      sendJson(req, res, 200, history);
      return true;
    }

    // GET /api/storage/market-share
    if (p === '/api/storage/market-share' && req.method === 'GET') {
      const share = await storageDb.getMarketShare();
      sendJson(req, res, 200, share);
      return true;
    }

    // GET /api/storage/benchmarks
    if (p === '/api/storage/benchmarks' && req.method === 'GET') {
      const source = url.searchParams.get('source') || undefined;
      const region = url.searchParams.get('region') || undefined;
      const benchmarks = await storageDb.getMlsBenchmarks({ source, region });
      sendJson(req, res, 200, benchmarks);
      return true;
    }

    // POST /api/storage/facilities/bulk
    if (p === '/api/storage/facilities/bulk' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const facilities = Array.isArray(body) ? body : body.facilities || [];
      const result = await storageDb.upsertFacilities(facilities);
      sendJson(req, res, 200, result);
      return true;
    }

    // POST /api/storage/pricing/bulk
    if (p === '/api/storage/pricing/bulk' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const snapshots = Array.isArray(body) ? body : body.snapshots || [];
      const result = await storageDb.insertPricingSnapshots(snapshots);
      sendJson(req, res, 200, result);
      return true;
    }

    // POST /api/storage/scrape/run - the "Update prices" button: starts the GitHub Actions storage scraper (admin only)
    if (p === '/api/storage/scrape/run' && req.method === 'POST') {
      const { startStorageScrape } = require('./scraperTrigger');
      sendJson(req, res, 200, await startStorageScrape());
      return true;
    }

    // GET /api/storage/scrape/status - latest manual scraper run (for the button's progress text)
    if (p === '/api/storage/scrape/status' && req.method === 'GET') {
      const { latestRun } = require('./scraperTrigger');
      res.removeHeader('Cache-Control');
      sendJson(req, res, 200, { run: await latestRun() });
      return true;
    }

    // POST /api/storage/summary/refresh  (scraper calls this after uploading prices)
    if (p === '/api/storage/summary/refresh' && req.method === 'POST') {
      const sum = await storageDb.refreshStorageSummary();
      sendJson(req, res, 200, { ok: true, computedAt: sum.computedAt, activeSnapshots: sum.activeSnapshots, facilities: sum.totalFacilities });
      return true;
    }

    // POST /api/storage/benchmarks/bulk
    if (p === '/api/storage/benchmarks/bulk' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const benchmarks = Array.isArray(body) ? body : body.benchmarks || [];
      const result = await storageDb.upsertMlsBenchmarks(benchmarks);
      sendJson(req, res, 200, result);
      return true;
    }

    sendJson(req, res, 404, { error: `Storage endpoint not found: ${p}` });
    return true;
  } catch (err) {
    console.error(`[storageRouter] Error handling ${p}:`, err);
    res.removeHeader('Cache-Control'); // never let the browser cache an error
    sendJson(req, res, err.status && err.status >= 400 && err.status < 600 ? err.status : 500, { error: err.message || 'Internal server error' });
    return true;
  }
}

module.exports = {
  handleStorageRequest,
};
