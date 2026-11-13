/**
 * Map view (read-only): turns the board's jobs for one day into map points.
 *
 * - Geocoding is lazy and cached forever in Firestore (`geocache/{sha1(normalized address)}`), so every
 *   address is looked up once. Primary: US Census geocoder (free, no key). Fallback: OpenStreetMap
 *   Nominatim (free, ~1 req/s, needs a User-Agent).
 * - A request geocodes at most MAX_LOOKUPS_PER_REQUEST new addresses; the response says how many are
 *   still `pending` so the page can ask again a moment later.
 * - Nothing here writes to the board's collections. Only `geocache` is written.
 * - Motive (live truck positions) is NOT part of this file yet.
 */
const crypto = require('crypto');

const WAREHOUSE_ADDRESS = process.env.WAREHOUSE_ADDRESS || '101 International Dr #120, Sterling, VA 20166';
const MAX_LOOKUPS_PER_REQUEST = 20;
const NEGATIVE_RETRY_MS = 7 * 24 * 3600 * 1000;
const LOOKBACK_DAYS = 45; // a long-distance trip can have started this long ago and still be running
const UA = 'ATM-Hub-Scheduler/1.0 (internal dispatch map)';

function normalizeAddress(addr) {
  return String(addr || '')
    .toLowerCase()
    .replace(/#\s*\w+/g, ' ')                                   // "#120"
    .replace(/\b(apt|apartment|unit|ste|suite|bldg|building|fl|floor)\.?\s*\w+/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const cacheKey = (addr) => crypto.createHash('sha1').update(normalizeAddress(addr)).digest('hex');

function isoShift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Returns {lat, lng} or null (no match). Throws only on network/service errors. */
async function geocodeRemote(address) {
  const q = encodeURIComponent(address.replace(/#\s*\w+/g, ' ').replace(/\s+/g, ' ').trim());
  try {
    const j = await fetchJson(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${q}&benchmark=Public_AR_Current&format=json`);
    const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (m && m.coordinates) return { lat: m.coordinates.y, lng: m.coordinates.x };
  } catch (_) { /* fall through to Nominatim */ }
  await new Promise((r) => setTimeout(r, 1100)); // Nominatim usage policy: max 1 request/second
  const j = await fetchJson(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=us`);
  if (Array.isArray(j) && j[0]) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
  // Last resort for bases, landmarks and city-only addresses ("Minot, ND", "Joint Base Andrews, MD"):
  // look up just the last two comma parts (city/place + state) so the trip still gets a dot.
  const parts = address.split(',').map((x) => x.replace(/\b\d{5}(-\d{4})?\b/g, '').trim()).filter(Boolean);
  if (parts.length > 2) {
    await new Promise((r) => setTimeout(r, 1100));
    const q2 = encodeURIComponent(parts.slice(-2).join(', '));
    const j2 = await fetchJson(`https://nominatim.openstreetmap.org/search?q=${q2}&format=json&limit=1&countrycodes=us`);
    if (Array.isArray(j2) && j2[0]) return { lat: parseFloat(j2[0].lat), lng: parseFloat(j2[0].lon) };
  }
  return null;
}

/**
 * Resolve addresses to coordinates using the cache first. Returns { coords: Map(address -> {lat,lng}),
 * unresolved: [address], pending: n }.
 */
async function resolveAddresses(addresses, { fsdb, geocode = geocodeRemote, maxLookups = MAX_LOOKUPS_PER_REQUEST, now = Date.now() }) {
  const unique = [...new Set(addresses.filter(Boolean))];
  const byKey = new Map(); // key -> [addresses]
  for (const a of unique) {
    const k = cacheKey(a);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(a);
  }
  const keys = [...byKey.keys()];
  const cached = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const refs = keys.slice(i, i + 100).map((k) => fsdb.collection('geocache').doc(k));
    const snaps = refs.length ? await fsdb.getAll(...refs) : [];
    snaps.forEach((s) => { if (s.exists) cached.set(s.id, s.data()); });
  }

  const coords = new Map();
  const unresolved = [];
  let lookups = 0;
  let pending = 0;
  for (const k of keys) {
    const addrs = byKey.get(k);
    const c = cached.get(k);
    let hit = null;
    if (c && c.ok) hit = { lat: c.lat, lng: c.lng };
    else if (c && !c.ok && c.v === 2 && now - (c.at || 0) < NEGATIVE_RETRY_MS) { addrs.forEach((a) => unresolved.push(a)); continue; }
    else if (lookups >= maxLookups) { pending += 1; continue; }
    else {
      lookups += 1;
      try {
        hit = await geocode(addrs[0]);
        await fsdb.collection('geocache').doc(k).set({ v: 2, address: addrs[0], ok: !!hit, lat: hit ? hit.lat : null, lng: hit ? hit.lng : null, at: now });
      } catch (_) { pending += 1; continue; } // service hiccup: not cached, try again next request
      if (!hit) { addrs.forEach((a) => unresolved.push(a)); continue; }
    }
    addrs.forEach((a) => coords.set(a, hit));
  }
  return { coords, unresolved, pending };
}

/**
 * kind: 'local' (everything except long distance) | 'ld' (long distance only).
 * A job is shown on `date` if date <= day <= endDate (multi-day long-distance trips span days).
 */
async function buildMap(db, date, kind, deps = {}) {
  const fsdb = deps.fsdb || require('./firestore').db;
  const day = isIso(date) ? date : new Date().toISOString().slice(0, 10);
  const mode = kind === 'ld' ? 'ld' : 'local';

  const [rows, td] = await Promise.all([
    db.listJobsInRange(isoShift(day, -LOOKBACK_DAYS), day),
    db.getTrucksAndDrivers(),
  ]);
  const trucks = new Map((td.trucks || []).map((t) => [t.id, t]));
  const jobs = rows.filter((j) => {
    if (!j || j.status === 'cancelled' || j.deletedAt) return false;
    const isLd = j.type === 'long_distance';
    if (mode === 'ld' ? !isLd : isLd) return false;
    return (j.endDate || j.date) >= day;
  }).sort((a, b) => String(a.startTime || '99').localeCompare(String(b.startTime || '99')));

  const addrs = [WAREHOUSE_ADDRESS];
  jobs.forEach((j) => { addrs.push(j.origin, j.destination); });
  const { coords, unresolved, pending } = await resolveAddresses(addrs, { fsdb, geocode: deps.geocode, maxLookups: deps.maxLookups });

  const pt = (addr) => (addr && coords.get(addr) ? { address: addr, ...coords.get(addr) } : addr ? { address: addr, lat: null, lng: null } : null);
  return {
    date: day,
    kind: mode,
    warehouse: pt(WAREHOUSE_ADDRESS),
    pending,
    unresolved: [...new Set(unresolved)],
    jobs: jobs.map((j) => ({
      id: j.id,
      customer: j.customer || '',
      type: j.type,
      date: j.date,
      endDate: j.endDate || j.date,
      startTime: j.startTime || null,
      miles: j.miles || null,
      origin: pt(j.origin),
      destination: pt(j.destination),
      trucks: (j.truckIds || []).map((id) => {
        const t = trucks.get(id);
        return { id, name: (t && (t.name || t.label)) || id, color: (t && t.color) || null };
      }),
    })),
  };
}

module.exports = { buildMap, resolveAddresses, normalizeAddress, cacheKey, WAREHOUSE_ADDRESS };
