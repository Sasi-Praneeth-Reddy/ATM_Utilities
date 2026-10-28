/**
 * server/leads/leadsDb.js
 *
 * Dedicated Firestore access layer for Pre-Mover Leads and Address Matching.
 *
 * Collections:
 *  - `preMoverLeads`: Stores USA Home Listings data
 *  - `legacyCustomers`: Stores imported historical customer records
 *  - `matchedLeads`: Stores matched previous customers whose homes are on the market
 *
 * NOTE: Reads from the existing `jobs` collection strictly in READ-ONLY mode.
 * Does not mutate or modify any existing scheduler job, truck, or driver records.
 */

const { db: fs } = require('../firestore');
const { findMatchesForListing, buildAddressKeys } = require('./addressMatcher');
const zipcodes = require('zipcodes');
const { FieldPath } = require('firebase-admin/firestore');

const leadsCol = fs.collection('preMoverLeads');
const legacyCustomersCol = fs.collection('legacyCustomers');
const matchedLeadsCol = fs.collection('matchedLeads');
const jobsCol = fs.collection('jobs'); // READ-ONLY reference
const systemCol = fs.collection('system');

/* ---------------------------------------------------------------------------------------------
 * Cost controls (added 2026-10-27). There are ~27K listings, so a naive "read everything" on every
 * request or ingest would burn tens of thousands of Firestore reads each time. Instead:
 *  - Browsing uses cursor paging (a page costs ~50 reads) while the in-memory snapshot is cold.
 *  - Search / price filters (which Firestore can't do natively) load a compact snapshot of ALL
 *    listings into this instance's memory once (cached LEADS_CACHE_TTL_MS), so filtering, exact
 *    totals and page jumps cost 0 reads while it's warm.
 *  - Ingest/reconcile only ever look at the listings that were just ingested or changed.
 *  - Analytics are computed over ALL listings at most once a day and stored in one document.
 * ------------------------------------------------------------------------------------------- */
const LEADS_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const PAST_MOVES_CACHE_TTL_MS = 5 * 60 * 1000;
const ANALYTICS_TTL_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_INGEST_REFRESH_MS = 12 * 60 * 60 * 1000;
const RECONCILE_COOLDOWN_MS = 5 * 60 * 1000;

let leadsSnapshot = { rows: null, loadedAt: 0, loading: null };
function leadsCacheWarm() {
  return Boolean(leadsSnapshot.rows) && Date.now() - leadsSnapshot.loadedAt < LEADS_CACHE_TTL_MS;
}
function invalidateLeadsCache() {
  leadsSnapshot = { rows: null, loadedAt: 0, loading: null };
}
/** All listings as [{ id, d }] sorted by document id (same order Firestore uses). */
async function getLeadsSnapshot() {
  if (leadsCacheWarm()) return leadsSnapshot.rows;
  if (leadsSnapshot.loading) return leadsSnapshot.loading;
  const loading = (async () => {
    const snap = await leadsCol.get();
    const rows = snap.docs.map((doc) => ({ id: doc.id, d: doc.data() }));
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    leadsSnapshot = { rows, loadedAt: Date.now(), loading: null };
    return rows;
  })().catch((err) => {
    leadsSnapshot = { rows: null, loadedAt: 0, loading: null };
    throw err;
  });
  leadsSnapshot.loading = loading;
  return loading;
}

/**
 * Generate a clean document ID from text.
 */
function toDocId(prefix, text) {
  const clean = String(text || '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(0, 50);
  return `${prefix}_${clean || Date.now()}`;
}

// ================================================================
// USA HOME LISTINGS (PRE-MOVER LEADS)
// ================================================================

/**
 * Bulk upsert USA Home Listings into Firestore.
 * Automatically dedupes by address + zip code.
 */
async function upsertPreMoverLeads(leads = []) {
  if (!Array.isArray(leads) || leads.length === 0) return { inserted: 0, updated: 0 };

  let inserted = 0;
  let updated = 0;
  const ingested = [];
  const now = new Date().toISOString();

  // Firestore allows up to 500 writes per batch
  const batchSize = 400;
  for (let i = 0; i < leads.length; i += batchSize) {
    const chunk = leads.slice(i, i + batchSize);
    const batch = fs.batch();

    for (const lead of chunk) {
      if (!lead.address) continue;
      const addrKeys = buildAddressKeys({
        street: lead.address,
        zip: lead.zipCode || lead.zip_code || lead.zip,
        city: lead.city,
        state: lead.state,
      });

      const docId = toDocId('lead', addrKeys.primaryKey || `${lead.address}_${lead.zip_code || ''}`);
      const docRef = leadsCol.doc(docId);

      const data = {
        id: docId,
        address: lead.address,
        city: lead.city || '',
        state: lead.state || '',
        zipCode: addrKeys.zip5 || lead.zip_code || lead.zip || '',
        county: lead.county || '',
        status: lead.status || 'for_sale',
        previousStatus: lead.previous_status || lead.previousStatus || '',
        listPrice: Number(lead.list_price || lead.listPrice || 0) || null,
        bedrooms: Number(lead.bedrooms || 0) || null,
        bathrooms: Number(lead.bathrooms || 0) || null,
        sqft: Number(lead.sqft || 0) || null,
        isVacant: Boolean(lead.is_vacant || lead.isVacant),
        listedDate: lead.listed_date || lead.listedDate || now.slice(0, 10),
        realtorName: lead.realtor_name || lead.realtorName || '',
        realtorEmail: lead.realtor_email || lead.realtorEmail || '',
        realtorPhone: lead.realtor_phone || lead.realtorPhone || '',
        realtorAddress: lead.realtor_address || lead.realtorAddress || '',
        brokerName: lead.broker_name || lead.brokerName || '',
        source: 'usahomelistings',
        lastUpdated: now,
      };

      batch.set(docRef, data, { merge: true });
      ingested.push(data);
      inserted++;
    }

    await batch.commit();
  }

  invalidateLeadsCache();

  // Match detection for ONLY the listings just ingested (previously this re-read all ~27K listings
  // after every ingest call). Awaited, not fire-and-forget: a Cloud Function may stop running the
  // moment the response is sent, which would silently drop a background promise.
  let newMatches = 0;
  try {
    const result = await reconcileMatches({ listings: ingested });
    newMatches = result.newMatchesCount || 0;
  } catch (err) {
    console.error('[leadsDb] Match reconciliation after ingest failed:', err);
  }
  // Keep the dashboard numbers fresh without recomputing on every ingest chunk.
  try {
    await refreshLeadsAnalyticsIfStale();
  } catch (err) {
    console.error('[leadsDb] Analytics refresh after ingest failed:', err);
  }

  return { total: inserted, newMatches };
}

// Comprehensive Northern Virginia, DC, and Maryland Geographic Coordinates
const NOVA_ZIP_COORDS = {
  // Loudoun County
  '20147': [39.0438, -77.4874], // Ashburn
  '20148': [38.9882, -77.5028], // Ashburn South / Brambleton
  '20164': [39.0062, -77.3975], // Sterling
  '20165': [39.0415, -77.3694], // Sterling North / Cascades
  '20166': [38.9806, -77.4267], // Sterling South
  '20175': [39.0984, -77.5878], // Leesburg South
  '20176': [39.1415, -77.5383], // Leesburg North
  '20105': [38.9744, -77.5878], // Aldie
  '20132': [39.1389, -77.7139], // Purcellville
  '20141': [39.1322, -77.7689], // Round Hill
  '20152': [38.9178, -77.5256], // South Riding
  '20158': [39.1344, -77.6622], // Hamilton
  '20129': [39.1489, -77.6178], // Paeonian Springs
  '20180': [39.2744, -77.6367], // Lovettsville

  // Fairfax County
  '20170': [38.9696, -77.3861], // Herndon
  '20171': [38.9248, -77.3989], // Herndon South / Floris
  '20190': [38.9587, -77.3570], // Reston North
  '20191': [38.9247, -77.3486], // Reston South
  '20194': [38.9782, -77.3328], // Reston East
  '22030': [38.8576, -77.3064], // Fairfax
  '22031': [38.8687, -77.2475], // Fairfax East
  '22032': [38.8242, -77.3014], // Fairfax South
  '22033': [38.8872, -77.3772], // Fairfax West
  '22180': [38.9012, -77.2655], // Vienna
  '22181': [38.8871, -77.3044], // Vienna South
  '22182': [38.9348, -77.2458], // Vienna North / Tysons
  '22101': [38.9338, -77.1773], // McLean
  '22102': [38.9287, -77.2178], // McLean Tysons
  '22066': [39.0048, -77.2917], // Great Falls
  '20120': [38.8576, -77.4478], // Centreville
  '20121': [38.8389, -77.4389], // Centreville South
  '20124': [38.8078, -77.3756], // Clifton
  '20151': [38.8878, -77.4456], // Chantilly
  '22003': [38.8315, -77.1958], // Annandale
  '22015': [38.7844, -77.2725], // Burke
  '22041': [38.8544, -77.1422], // Falls Church South
  '22042': [38.8722, -77.1956], // Falls Church West
  '22043': [38.9022, -77.1956], // Falls Church Pimmit
  '22044': [38.8722, -77.1511], // Falls Church Sleepy Hollow
  '22046': [38.8823, -77.1711], // Falls Church City
  '22079': [38.7042, -77.2178], // Lorton
  '22124': [38.8844, -77.2975], // Oakton
  '22150': [38.7844, -77.1778], // Springfield
  '22151': [38.8144, -77.2178], // Springfield North
  '22152': [38.7778, -77.2456], // Springfield West
  '22153': [38.7422, -77.2456], // Springfield South

  // Arlington & Alexandria
  '22201': [38.8863, -77.0942], // Arlington (Clarendon)
  '22202': [38.8569, -77.0544], // Arlington (Crystal City)
  '22203': [38.8789, -77.1122], // Arlington (Ballston)
  '22204': [38.8617, -77.0944], // Arlington (Columbia Pike)
  '22205': [38.8844, -77.1472], // Arlington (Westover)
  '22206': [38.8456, -77.0911], // Arlington (Shirlington)
  '22207': [38.9078, -77.1289], // Arlington North
  '22209': [38.8978, -77.0711], // Arlington (Rosslyn)
  '22213': [38.8922, -77.1578], // Arlington East Falls Church
  '22301': [38.8239, -77.0558], // Alexandria (Del Ray)
  '22302': [38.8353, -77.0864], // Alexandria
  '22303': [38.7889, -77.0856], // Alexandria (Huntington)
  '22304': [38.8153, -77.1197], // Alexandria West
  '22305': [38.8378, -77.0589], // Alexandria (Arlandria)
  '22306': [38.7556, -77.0922], // Alexandria (Groveton)
  '22307': [38.7756, -77.0556], // Alexandria (Belle Haven)
  '22308': [38.7356, -77.0656], // Alexandria (Mount Vernon)
  '22309': [38.7156, -77.1256], // Alexandria (Engleside)
  '22310': [38.7889, -77.1356], // Alexandria (Rose Hill)
  '22311': [38.8389, -77.1311], // Alexandria (Seminary)
  '22312': [38.8156, -77.1689], // Alexandria (Lincolnia)
  '22314': [38.8048, -77.0469], // Alexandria (Old Town)
  '22315': [38.7611, -77.1456], // Alexandria (Kingstowne)

  // Prince William County
  '20109': [38.7844, -77.5097], // Manassas
  '20110': [38.7489, -77.4756], // Manassas City
  '20111': [38.7744, -77.4456], // Manassas Park
  '20112': [38.6878, -77.4422], // Manassas South
  '20136': [38.7244, -77.5389], // Bristow
  '20155': [38.7989, -77.6156], // Gainesville
  '20169': [38.8122, -77.6367], // Haymarket
  '20181': [38.6478, -77.5856], // Nokesville
  '22025': [38.5678, -77.3278], // Dumfries
  '22026': [38.5878, -77.3078], // Dumfries Triangle
  '22191': [38.6478, -77.2656], // Woodbridge
  '22192': [38.6878, -77.3244], // Woodbridge West / Lake Ridge
  '22193': [38.6544, -77.3689], // Dale City

  // Montgomery County MD
  '20814': [38.9989, -77.1122], // Bethesda MD
  '20815': [38.9833, -77.0833], // Chevy Chase MD
  '20817': [38.9989, -77.1489], // Bethesda West MD
  '20850': [39.0833, -77.1511], // Rockville MD
  '20852': [39.0544, -77.1278], // Rockville South MD
  '20853': [39.0833, -77.1011], // Rockville East MD
  '20854': [39.0278, -77.2156], // Potomac MD
  '20874': [39.1733, -77.2711], // Germantown MD
  '20876': [39.1911, -77.2489], // Germantown North MD
  '20877': [39.1433, -77.2011], // Gaithersburg MD
  '20878': [39.1244, -77.2344], // Gaithersburg West MD
  '20879': [39.1711, -77.1856], // Gaithersburg East MD
  '20882': [39.2211, -77.1656], // Gaithersburg North MD
  '20901': [39.0233, -77.0111], // Silver Spring MD
  '20902': [39.0389, -77.0511], // Silver Spring Wheaton MD
  '20904': [39.0689, -76.9856], // Silver Spring Colesville MD
  '20906': [39.0789, -77.0656], // Silver Spring Aspen Hill MD
  '20910': [38.9978, -77.0344], // Silver Spring Downtown MD

  // Washington DC
  '20001': [38.9106, -77.0163], // DC (Shaw / Mount Vernon)
  '20002': [38.9076, -76.9856], // DC (Capitol Hill / H Street)
  '20003': [38.8822, -76.9956], // DC (Navy Yard / SE)
  '20005': [38.9056, -77.0311], // DC (Logan Circle)
  '20007': [38.9178, -77.0678], // DC (Georgetown / Glover Park)
  '20008': [38.9356, -77.0589], // DC (Cleveland Park)
  '20009': [38.9189, -77.0411], // DC (Adams Morgan / Dupont)
  '20010': [38.9333, -77.0311], // DC (Columbia Heights)
  '20011': [38.9511, -77.0211], // DC (Petworth)
  '20012': [38.9756, -77.0256], // DC (Takoma)
  '20015': [38.9689, -77.0756], // DC (Chevy Chase DC)
  '20016': [38.9344, -77.0878], // DC (Tenleytown / AU Park)
  '20019': [38.8922, -76.9456], // DC (Deanwood)
  '20020': [38.8622, -76.9756], // DC (Anacostia)
  '20024': [38.8789, -77.0189], // DC (Southwest Waterfront)
  '20036': [38.9067, -77.0422], // DC (Dupont Circle South)
};

function resolveCoordinates(data) {
  let lat = Number(data.lat || data.latitude);
  let lon = Number(data.lon || data.longitude);
  if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
    return { lat, lon };
  }

  const cleanZip = String(data.zipCode || data.zip_code || '').trim().slice(0, 5);
  let baseCoords = NOVA_ZIP_COORDS[cleanZip];

  if (!baseCoords) {
    try {
      const z = zipcodes.lookup(cleanZip);
      if (z && z.latitude && z.longitude) {
        baseCoords = [z.latitude, z.longitude];
      }
    } catch (e) {
      // ignore
    }
  }

  if (!baseCoords) {
    // Default to Tysons Corner / NOVA regional center
    baseCoords = [38.9187, -77.2311];
  }

  // Deterministic neighborhood offset based on street name
  const hash = (data.address || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const jitterLat = ((hash % 100) - 50) * 0.00035;
  const jitterLon = (((hash * 17) % 100) - 50) * 0.00035;

  return {
    lat: Number((baseCoords[0] + jitterLat).toFixed(6)),
    lon: Number((baseCoords[1] + jitterLon).toFixed(6)),
  };
}

/**
 * List pre-mover leads with optional filtering and pagination.
 */
function toLeadRow(d) {
  const coords = resolveCoordinates(d);
  return { ...d, lat: coords.lat, lon: coords.lon };
}

function listingMatchesFilters(d, { status, state, county, search, minPrice, maxPrice, month }) {
  if (month && month !== 'all' && String(d.listedDate || d.scrapedAt || '').slice(0, 7) !== month) return false;
  if (status && status !== 'all' && d.status !== status) return false;
  if (state && state !== 'all' && d.state !== state) return false;
  if (county && county !== 'all' && d.county !== county) return false;
  if (minPrice && !(d.listPrice && d.listPrice >= Number(minPrice))) return false;
  if (maxPrice && !(d.listPrice && d.listPrice <= Number(maxPrice))) return false;
  if (search) {
    const q = String(search).toLowerCase();
    const hit =
      (d.address && d.address.toLowerCase().includes(q)) ||
      (d.city && d.city.toLowerCase().includes(q)) ||
      (d.zipCode && String(d.zipCode).includes(q)) ||
      (d.realtorName && d.realtorName.toLowerCase().includes(q)) ||
      (d.ownerFullName && d.ownerFullName.toLowerCase().includes(q));
    if (!hit) return false;
  }
  return true;
}

/**
 * Paged listing search. Returns { total, leads, offset, limit, endCursor, source }.
 *  - Search / price filters, or a warm in-memory snapshot: served from memory (0 reads, exact total).
 *  - Otherwise Firestore with equality filters ordered by document id. `after` (the previous page's
 *    `endCursor`) makes a page cost ~`limit` reads. Without it, `offset` is used only while it is
 *    cheap (first 2,000 results, or a result set under 6,000); a deeper jump loads the in-memory
 *    snapshot once (cached for 2 hours) instead of paying Firestore for every skipped document.
 *    (No descending order is used, so no extra Firestore index is required.)
 */
async function listPreMoverLeads({
  status,
  county,
  state,
  search,
  minPrice,
  maxPrice,
  month,
  limit = 50,
  offset = 0,
  after,
} = {}) {
  const fetchLimit = Math.min(Math.max(Number(limit) || 50, 10), 200);
  const fetchOffset = Math.max(Number(offset) || 0, 0);
  const filters = { status, state, county, search, minPrice, maxPrice, month };

  async function fromSnapshot() {
    const all = await getLeadsSnapshot();
    const filtered = all.filter((r) => listingMatchesFilters(r.d, filters));
    const page = filtered.slice(fetchOffset, fetchOffset + fetchLimit);
    return {
      total: filtered.length,
      leads: page.map((r) => toLeadRow(r.d)),
      offset: fetchOffset,
      limit: fetchLimit,
      endCursor: page.length ? page[page.length - 1].id : null,
      source: 'cache',
    };
  }

  // The month filter is served from the in-memory snapshot too (a date-range query would need its own index).
  if (search || minPrice || maxPrice || (month && month !== 'all') || leadsCacheWarm()) return fromSnapshot();

  let query = leadsCol;
  if (status && status !== 'all') query = query.where('status', '==', status);
  if (state && state !== 'all') query = query.where('state', '==', state);
  if (county && county !== 'all') query = query.where('county', '==', county);

  let total = null;
  try {
    total = (await query.count().get()).data().count;
  } catch (e) {
    console.warn('[leadsDb] count() failed:', e.message);
  }

  const cheapOffset = fetchOffset <= 2000 || (total !== null && total <= 6000);
  if (!after && !cheapOffset) return fromSnapshot();

  const byId = FieldPath.documentId();
  const ordered = query.orderBy(byId);
  const docs = (after
    ? await ordered.startAfter(String(after)).limit(fetchLimit).get()
    : await ordered.offset(fetchOffset).limit(fetchLimit).get()
  ).docs;

  return {
    total: total === null ? docs.length : total,
    leads: docs.map((d) => toLeadRow(d.data())),
    offset: fetchOffset,
    limit: fetchLimit,
    endCursor: docs.length ? docs[docs.length - 1].id : null,
    source: 'firestore',
  };
}

// ================================================================
// LEGACY CUSTOMERS
// ================================================================

/**
 * Import historical legacy customer records from CSV/Excel parsing.
 */
async function importLegacyCustomers(customers = []) {
  if (!Array.isArray(customers) || customers.length === 0) return { imported: 0 };

  const now = new Date().toISOString();
  let count = 0;
  const batchSize = 400;

  for (let i = 0; i < customers.length; i += batchSize) {
    const chunk = customers.slice(i, i + batchSize);
    const batch = fs.batch();

    for (const c of chunk) {
      if (!c.name && !c.address && !c.destinationAddress) continue;

      const docId = toDocId('leg', `${c.name || ''}_${c.destinationAddress || c.address || ''}_${count}`);
      const docRef = legacyCustomersCol.doc(docId);

      const record = {
        id: docId,
        name: c.name || c.customerName || 'Customer',
        email: c.email || '',
        phone: c.phone || c.phoneNumber || '',
        originAddress: c.originAddress || c.movingFrom || c.from || '',
        destinationAddress: c.destinationAddress || c.movingTo || c.address || c.to || '',
        city: c.city || '',
        state: c.state || '',
        zip: c.zip || c.zipCode || '',
        moveDate: c.moveDate || c.serviceDate || c.date || '',
        notes: c.notes || '',
        importedAt: now,
      };

      batch.set(docRef, record, { merge: true });
      count++;
    }

    await batch.commit();
  }

  // Run matching after import
  await reconcileMatches();

  return { imported: count };
}

/**
 * List imported legacy customers.
 */
async function listLegacyCustomers(limit = 100) {
  const snap = await legacyCustomersCol.limit(limit).get();
  return snap.docs.map((d) => d.data());
}

// ================================================================
// ADDRESS MATCHING & RECONCILIATION
// ================================================================

let pastMovesCache = { index: null, loadedAt: 0 };

/** Past customer addresses (booked jobs + legacy customers) indexed by normalized base street. Cached
 * a few minutes in memory so a burst of ingest calls doesn't re-read every job each time. */
async function getPastMoveIndex() {
  if (pastMovesCache.index && Date.now() - pastMovesCache.loadedAt < PAST_MOVES_CACHE_TTL_MS) {
    return pastMovesCache.index;
  }
  const [jobsSnap, legacySnap] = await Promise.all([jobsCol.get(), legacyCustomersCol.get()]);
  const jobs = jobsSnap.docs.map((d) => d.data()).filter((j) => j && (j.origin || j.destination));
  const legacyCustomers = legacySnap.docs.map((d) => d.data());

  const index = new Map();
  function indexRecord(street, zip, record, type) {
    if (!street) return;
    const keys = buildAddressKeys({ street, zip });
    if (!keys.baseStreet) return;
    if (!index.has(keys.baseStreet)) index.set(keys.baseStreet, []);
    index.get(keys.baseStreet).push({ record, keys, type });
  }
  for (const job of jobs) {
    if (job.destination) indexRecord(job.destination, job.destinationZip, job, 'moved_to');
    if (job.origin) indexRecord(job.origin, job.originZip, job, 'moved_from');
  }
  for (const leg of legacyCustomers) {
    const addr = leg.destinationAddress || leg.address || leg.originAddress;
    if (addr) indexRecord(addr, leg.zip || leg.zipCode, leg, 'legacy');
  }
  pastMovesCache = { index, loadedAt: Date.now() };
  console.log(`[leadsDb] Indexed ${index.size} past customer addresses (${jobs.length} jobs, ${legacyCustomers.length} legacy).`);
  return index;
}

/**
 * Matches listings against past customers (booked jobs + legacy customers) and saves matches.
 *  - { listings }: check just those listings (used by ingest; no listing reads at all).
 *  - no args: "incremental" — only listings added/changed since the last manual run
 *    (system/leadsReconcile.lastRunAt); the very first run, or { full: true }, checks all listings.
 *  - { dryRun: true }: compute and return counts without writing anything.
 * Existing matches keep their status/notes/outreach history.
 */
async function reconcileMatches({ listings: given, full = false, dryRun = false } = {}) {
  const startedAt = new Date().toISOString();
  const stateRef = systemCol.doc('leadsReconcile');
  let listings = given;
  let mode = 'ingest';

  if (!listings) {
    const stateSnap = await stateRef.get();
    const lastRunAt = stateSnap.exists ? stateSnap.data().lastRunAt : null;
    if (full || !lastRunAt) {
      mode = 'full';
      listings = (await leadsCol.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    } else {
      mode = 'incremental';
      listings = (await leadsCol.where('lastUpdated', '>', lastRunAt).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    }
  }

  if (!listings.length) {
    if (mode !== 'ingest' && !dryRun) {
      await stateRef.set({ lastRunAt: startedAt, lastMode: mode, listingsChecked: 0 }, { merge: true });
    }
    return { newMatchesCount: 0, listingsChecked: 0, mode };
  }

  const index = await getPastMoveIndex();
  const { compareAddressKeys } = require('./addressMatcher');

  // Pass 1: find candidate matches in memory
  const candidates = [];
  for (const listing of listings) {
    const listingKeys = buildAddressKeys({
      street: listing.address,
      zip: listing.zipCode || listing.zip_code || listing.zip,
      city: listing.city,
      state: listing.state,
    });
    if (!listingKeys.baseStreet) continue;
    const pool = index.get(listingKeys.baseStreet);
    if (!pool || pool.length === 0) continue;
    for (const { record: job, keys: targetKeys, type } of pool) {
      const comp = compareAddressKeys(listingKeys, targetKeys);
      if (!comp.isMatch) continue;
      candidates.push({ listing, job, type, comp, matchDocId: toDocId('match', `${job.id}_${listing.address}`) });
    }
  }

  // Pass 2: load only the candidate matches that already exist (keeps staff-set status/notes)
  const existingMap = new Map();
  const uniqueIds = [...new Set(candidates.map((c) => c.matchDocId))];
  for (let i = 0; i < uniqueIds.length; i += 300) {
    const refs = uniqueIds.slice(i, i + 300).map((id) => matchedLeadsCol.doc(id));
    const snaps = await fs.getAll(...refs);
    snaps.forEach((snap) => { if (snap.exists) existingMap.set(snap.id, snap.data()); });
  }

  // Pass 3: write
  let newMatchesCount = 0;
  let batch = fs.batch();
  let batchOps = 0;
  for (const { listing, job, type, comp, matchDocId } of candidates) {
    const isLegacy = type === 'legacy';
    const existing = existingMap.get(matchDocId);
    const matchData = {
      id: matchDocId,
      leadId: listing.id,
      sourceType: isLegacy ? 'legacy_customer' : 'smartmoving_job',
      sourceId: job.id,
      customerName: isLegacy ? (job.name || 'Legacy Customer') : (job.customer || 'Customer'),
      customerEmail: job.email || (existing ? existing.customerEmail : null),
      customerPhone: job.phone || (existing ? existing.customerPhone : null),
      matchedAddress: listing.address,
      matchedType: type,
      previousMoveDate: isLegacy ? (job.moveDate || job.date || null) : (job.date || null),
      previousMoveDetails: isLegacy
        ? `Legacy move recorded on ${job.moveDate || 'past record'}`
        : type === 'moved_to'
          ? `Moved into this property on ${job.date || 'past move'}. Origin: ${job.origin || 'N/A'}`
          : `Moved from this property on ${job.date || 'past move'}. Destination: ${job.destination || 'N/A'}`,
      confidence: comp.confidence,
      matchReason: comp.matchReason,
      listingStatus: listing.status,
      listingPrice: listing.listPrice,
      listedDate: listing.listedDate,
      realtorName: listing.realtorName,
      realtorPhone: listing.realtorPhone,
      realtorEmail: listing.realtorEmail,
      // Status tracking: default to 'pending' unless already updated by staff
      status: existing ? existing.status : 'pending',
      notes: existing ? existing.notes || '' : '',
      outreachHistory: existing ? existing.outreachHistory || [] : [],
      lastChecked: startedAt,
    };
    if (!existing) {
      matchData.detectedAt = startedAt;
      newMatchesCount++;
    }
    if (dryRun) continue;
    batch.set(matchedLeadsCol.doc(matchDocId), matchData, { merge: true });
    batchOps++;
    if (batchOps >= 400) {
      await batch.commit();
      batch = fs.batch();
      batchOps = 0;
    }
  }
  if (batchOps > 0) await batch.commit();

  if (mode !== 'ingest' && !dryRun) {
    await stateRef.set(
      { lastRunAt: startedAt, lastMode: mode, listingsChecked: listings.length, newMatchesCount },
      { merge: true }
    );
  }
  console.log(`[leadsDb] Reconcile (${mode}${dryRun ? ', dry run' : ''}): ${listings.length} listings checked, ${candidates.length} candidates, ${newMatchesCount} new matches.`);
  return { newMatchesCount, listingsChecked: listings.length, candidates: candidates.length, mode };
}

/** Manual reconcile throttle: ms until another manual run is allowed (0 = allowed now). */
async function getReconcileCooldownMs() {
  const snap = await systemCol.doc('leadsReconcile').get();
  const last = snap.exists ? Date.parse(snap.data().lastManualAt || '') : NaN;
  if (Number.isNaN(last)) return 0;
  return Math.max(0, last + RECONCILE_COOLDOWN_MS - Date.now());
}
async function markManualReconcile() {
  await systemCol.doc('leadsReconcile').set({ lastManualAt: new Date().toISOString() }, { merge: true });
}

/**
 * List matched leads with status filter.
 */
async function listMatchedLeads(statusFilter) {
  let query = matchedLeadsCol;
  if (statusFilter && statusFilter !== 'all') {
    query = query.where('status', '==', statusFilter);
  }

  const snap = await query.get();
  const matches = snap.docs.map((d) => d.data());

  // Sort pending first, then by listedDate descending
  matches.sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return (b.listedDate || '').localeCompare(a.listedDate || '');
  });

  return matches;
}

/**
 * Update the review status of a matched lead ('pending' | 'contacted' | 'dismissed' | 'booked').
 */
async function updateMatchedLeadStatus(matchId, status, notes = '') {
  const docRef = matchedLeadsCol.doc(matchId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error(`Match not found: ${matchId}`);
  }

  const updates = {
    status,
    updatedAt: new Date().toISOString(),
  };
  if (notes) updates.notes = notes;

  await docRef.update(updates);
  return { id: matchId, status, ...updates };
}

/**
 * Record an outreach action (email sent) on a matched lead.
 */
async function recordOutreach(matchId, outreachRecord) {
  const docRef = matchedLeadsCol.doc(matchId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error(`Match not found: ${matchId}`);
  }

  const current = snap.data();
  const history = current.outreachHistory || [];
  history.push({
    ...outreachRecord,
    sentAt: new Date().toISOString(),
  });

  await docRef.update({
    status: 'contacted',
    outreachHistory: history,
    lastOutreachAt: new Date().toISOString(),
  });

  return { id: matchId, status: 'contacted', outreachHistory: history };
}

/**
 * Get summary KPI metrics for the Leads tab.
 */
async function getLeadsSummary() {
  let totalListings = 27221;
  try {
    const countSnap = await leadsCol.count().get();
    totalListings = countSnap.data().count;
  } catch (err) {
    console.warn('[leadsDb] count() fallback:', err.message);
  }

  const matchesSnap = await matchedLeadsCol.get();
  const matches = matchesSnap.docs.map((d) => d.data());
  const pendingCount = matches.filter((m) => m.status === 'pending').length;
  const contactedCount = matches.filter((m) => m.status === 'contacted').length;

  return {
    totalListings,
    totalMatches: matches.length,
    pendingMatches: pendingCount,
    contactedMatches: contactedCount,
  };
}

/**
 * Get comprehensive analytics matching the original Streamlit real estate view.
 */
function computeLeadsAnalytics(leads) {

  const countyMap = {};
  const countyPriceMap = {};
  const countyStatusMap = {};
  const statusMap = { for_sale: 0, under_contract: 0, pending: 0, closed: 0 };
  const realtorMap = {};
  const weeklyMap = {}; // keyed by the Monday (YYYY-MM-DD) of the listing's week
  const monthlyMap = {}; // keyed by YYYY-MM of the listing date
  const transitionMap = {};
  const statesSet = new Set(['VA', 'MD', 'DC', 'WV']);
  const countiesSet = new Set();
  const stateCountyMap = {
    VA: new Set([
      'Alexandria County', 'Arlington County', 'Clarke County', 'Culpeper County',
      'Fairfax County', 'Falls Church County', 'Fauquier County', 'Frederick County',
      'Fredericksburg County', 'Loudoun County', 'Manassas County', 'Middlesex County',
      'Orange County', 'Prince William County', 'Rappahannock County', 'Richmond City County',
      'Shenandoah County', 'Spotsylvania County', 'Stafford County', 'Warren County'
    ]),
    MD: new Set([
      'Anne Arundel County', 'Baltimore City County', 'Baltimore County', 'Calvert County',
      'Carroll County', 'Charles County', 'Frederick County', 'Howard County',
      'Montgomery County', "Prince George's County", "Saint Mary's County", 'Washington County'
    ]),
    DC: new Set([
      'District of Columbia'
    ]),
    WV: new Set([
      'Berkeley County', 'Jefferson County'
    ]),
  };

  let totalPrice = 0;
  let priceCount = 0;
  const prices = [];

  for (const l of leads) {
    if (l.state) {
      statesSet.add(l.state);
      if (l.county) {
        if (!stateCountyMap[l.state]) stateCountyMap[l.state] = new Set();
        stateCountyMap[l.state].add(l.county);
      }
    }
    const county = l.county || 'Fairfax County';
    countiesSet.add(county);
    countyMap[county] = (countyMap[county] || 0) + 1;

    const st = l.status || 'for_sale';
    statusMap[st] = (statusMap[st] || 0) + 1;

    if (!countyStatusMap[county]) {
      countyStatusMap[county] = { for_sale: 0, under_contract: 0, pending: 0, closed: 0 };
    }
    countyStatusMap[county][st] = (countyStatusMap[county][st] || 0) + 1;

    if (l.listPrice && Number(l.listPrice) > 0) {
      const p = Number(l.listPrice);
      totalPrice += p;
      priceCount++;
      prices.push(p);

      if (!countyPriceMap[county]) countyPriceMap[county] = { sum: 0, count: 0 };
      countyPriceMap[county].sum += p;
      countyPriceMap[county].count += 1;
    }

    // Monthly + weekly listing trend, by the date the home was LISTED (not when we ingested it —
    // the old version used the ingest date and a week-of-month formula, which mixed up weeks from
    // different months into meaningless "W01..W06" buckets).
    const dayStr = String(l.listedDate || l.scrapedAt || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
      const monthKey = dayStr.slice(0, 7);
      if (!monthlyMap[monthKey]) monthlyMap[monthKey] = { for_sale: 0, under_contract: 0, pending: 0, closed: 0, total: 0 };
      monthlyMap[monthKey][st] = (monthlyMap[monthKey][st] || 0) + 1;
      monthlyMap[monthKey].total += 1;

      const dt = new Date(`${dayStr}T00:00:00Z`);
      if (!isNaN(dt.getTime())) {
        dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // back to Monday
        const weekKey = dt.toISOString().slice(0, 10);
        if (!weeklyMap[weekKey]) weeklyMap[weekKey] = { for_sale: 0, under_contract: 0, pending: 0, closed: 0, total: 0 };
        weeklyMap[weekKey][st] = (weeklyMap[weekKey][st] || 0) + 1;
        weeklyMap[weekKey].total += 1;
      }
    }

    // Status transitions
    if (l.previousStatus && l.previousStatus !== l.status) {
      const transKey = `${l.previousStatus} → ${l.status}`;
      transitionMap[transKey] = (transitionMap[transKey] || 0) + 1;
    }

    if (l.realtorName && l.realtorName.trim()) {
      const name = l.realtorName.trim();
      if (!realtorMap[name]) {
        realtorMap[name] = {
          name,
          listings: 0,
          totalPrice: 0,
          phone: l.realtorPhone || '',
          email: l.realtorEmail || '',
          zips: new Set(),
        };
      }
      realtorMap[name].listings++;
      if (l.listPrice) realtorMap[name].totalPrice += Number(l.listPrice);
      if (l.zipCode) realtorMap[name].zips.add(l.zipCode);
      if (!realtorMap[name].phone && l.realtorPhone) realtorMap[name].phone = l.realtorPhone;
      if (!realtorMap[name].email && l.realtorEmail) realtorMap[name].email = l.realtorEmail;
    }
  }

  prices.sort((a, b) => a - b);
  const medianListPrice = prices.length > 0 ? prices[Math.floor(prices.length / 2)] : 725000;
  const avgListPrice = priceCount > 0 ? Math.round(totalPrice / priceCount) : 748000;

  const topCounties = Object.entries(countyMap)
    .map(([county, count]) => ({ county, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topCountyAvgPrices = Object.entries(countyPriceMap)
    .filter(([_, data]) => data.count >= 2)
    .map(([county, data]) => ({
      county,
      avgPrice: Math.round(data.sum / data.count),
      count: data.count,
    }))
    .sort((a, b) => b.avgPrice - a.avgPrice)
    .slice(0, 10);

  const topRealtors = Object.values(realtorMap)
    .map((r) => ({
      name: r.name,
      listings: r.listings,
      avgPrice: r.listings > 0 && r.totalPrice > 0 ? Math.round(r.totalPrice / r.listings) : null,
      phone: r.phone,
      email: r.email,
      zips: Array.from(r.zips).slice(0, 4).join(', '),
    }))
    .sort((a, b) => b.listings - a.listings)
    .slice(0, 30);

  // Last 12 weeks (week = Monday date) and every month on record (max 24), oldest first.
  const weeklyTrend = Object.entries(weeklyMap)
    .map(([week, counts]) => ({ week, ...counts }))
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-12);

  const monthlyTrend = Object.entries(monthlyMap)
    .map(([month, counts]) => ({ month, ...counts }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-24);

  const statusTransitions = Object.entries(transitionMap)
    .map(([transition, count]) => ({ transition, count }))
    .sort((a, b) => b.count - a.count);

  const cityMap = {};
  for (const l of leads) {
    if (l.city && l.city.trim()) {
      let cName = l.city.trim();
      if (cName.toLowerCase() === 'mc lean') cName = 'McLean';
      const st = l.state || 'VA';
      const key = `${cName}|${st}`;
      if (!cityMap[key]) {
        cityMap[key] = {
          city: cName,
          state: st,
          county: l.county || '',
          count: 0,
          for_sale: 0,
          under_contract: 0,
          pending: 0,
          closed: 0,
          totalPrice: 0,
          priceCount: 0,
        };
      }
      cityMap[key].count++;
      const status = l.status || 'for_sale';
      if (cityMap[key][status] !== undefined) cityMap[key][status]++;
      if (l.listPrice && Number(l.listPrice) > 0) {
        cityMap[key].totalPrice += Number(l.listPrice);
        cityMap[key].priceCount++;
      }
    }
  }

  const cityStats = Object.values(cityMap).map((c) => ({
    city: c.city,
    state: c.state,
    county: c.county,
    count: c.count,
    for_sale: c.for_sale,
    under_contract: c.under_contract,
    pending: c.pending,
    closed: c.closed,
    avgPrice: c.priceCount > 0 ? Math.round(c.totalPrice / c.priceCount) : null,
  })).sort((a, b) => b.count - a.count);

  const stateCounties = {};
  for (const [st, set] of Object.entries(stateCountyMap)) {
    stateCounties[st] = Array.from(set).sort();
  }

  return {
    totalSampled: leads.length,
    totalListingsAnalyzed: leads.length,
    avgListPrice,
    medianListPrice,
    statusCounts: statusMap,
    topCounties,
    topCountyAvgPrices,
    topRealtors,
    weeklyTrend,
    monthlyTrend,
    statusTransitions,
    countyStatusMatrix: countyStatusMap,
    cityStats,
    stateCounties,
    availableStates: Array.from(statesSet).sort(),
    availableCounties: Array.from(countiesSet).sort(),
  };
}

// ---- Analytics: computed over ALL listings at most once a day, stored in one document ----
let analyticsRefreshing = null;
async function refreshLeadsAnalytics() {
  if (analyticsRefreshing) return analyticsRefreshing;
  analyticsRefreshing = (async () => {
    const leads = leadsCacheWarm()
      ? leadsSnapshot.rows.map((r) => r.d)
      : (await leadsCol.get()).docs.map((d) => d.data());
    const result = computeLeadsAnalytics(leads);
    // Firestore documents cap at 1 MiB — keep the stored payload comfortably under it.
    let payload = JSON.stringify(result);
    if (payload.length > 900000) {
      result.cityStats = result.cityStats.slice(0, 400);
      payload = JSON.stringify(result);
    }
    const computedAt = new Date().toISOString();
    await systemCol.doc('leadsAnalytics').set({ computedAt, totalListings: leads.length, payload });
    return { ...result, computedAt };
  })().finally(() => { analyticsRefreshing = null; });
  return analyticsRefreshing;
}

async function readStoredAnalytics() {
  const snap = await systemCol.doc('leadsAnalytics').get();
  if (!snap.exists) return null;
  const { computedAt, payload } = snap.data();
  try {
    return { computedAt, result: { ...JSON.parse(payload), computedAt } };
  } catch (e) {
    return null;
  }
}

/** 1 read when the stored analytics are fresh (< 24h); otherwise recomputes over all listings. */
async function getLeadsAnalytics({ refresh = false } = {}) {
  if (!refresh) {
    const stored = await readStoredAnalytics();
    // A stored summary from before monthlyTrend existed is treated as stale so the new charts fill in.
    if (stored && stored.result && stored.result.monthlyTrend && Date.now() - Date.parse(stored.computedAt) < ANALYTICS_TTL_MS) return stored.result;
  }
  return refreshLeadsAnalytics();
}

async function refreshLeadsAnalyticsIfStale() {
  const stored = await readStoredAnalytics();
  if (stored && Date.now() - Date.parse(stored.computedAt) < ANALYTICS_INGEST_REFRESH_MS) return false;
  await refreshLeadsAnalytics();
  return true;
}

module.exports = {
  upsertPreMoverLeads,
  listPreMoverLeads,
  importLegacyCustomers,
  listLegacyCustomers,
  reconcileMatches,
  getReconcileCooldownMs,
  markManualReconcile,
  listMatchedLeads,
  updateMatchedLeadStatus,
  recordOutreach,
  getLeadsSummary,
  getLeadsAnalytics,
  refreshLeadsAnalytics,
  invalidateLeadsCache,
  // exposed for tests only
  _computeLeadsAnalytics: computeLeadsAnalytics,
};
