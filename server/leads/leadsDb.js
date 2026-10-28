/**
 * server/leads/leadsDb.js
 *
 * Data access layer for Pre-Mover Leads and Address Matching, backed by Firebase SQL Connect
 * (Cloud SQL for PostgreSQL) since 2026-10-28. Previously Firestore.
 *
 * Tables (see /dataconnect/schema/schema.gql): Lead, MatchedLead, LegacyCustomer, AppState.
 *
 * NOTE: Reads from the existing Firestore `jobs` collection strictly in READ-ONLY mode.
 * Does not mutate or modify any existing scheduler job, truck, or driver records.
 */

const { db: fs } = require('../firestore');
const sql = require('../sqlconnect');
const { findMatchesForListing, buildAddressKeys } = require('./addressMatcher');
const zipcodes = require('zipcodes');

const jobsCol = fs.collection('jobs'); // READ-ONLY reference (scheduler data stays in Firestore)

/* ---------------------------------------------------------------------------------------------
 * Caching. Listings (~27K rows) are loaded from SQL into memory once (LEADS_CACHE_TTL_MS) and
 * filtering / search / stats / export run against that snapshot, so every request after the first
 * is instant. Ingest invalidates it. Analytics are computed from the snapshot and stored in the
 * AppState table (daily).
 * ------------------------------------------------------------------------------------------- */
const LEADS_CACHE_TTL_MS = 30 * 60 * 1000;
const PAST_MOVES_CACHE_TTL_MS = 5 * 60 * 1000;
const ANALYTICS_TTL_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_INGEST_REFRESH_MS = 12 * 60 * 60 * 1000;
const RECONCILE_COOLDOWN_MS = 5 * 60 * 1000;

const LEAD_FIELDS = [
  'leadId', 'address', 'city', 'state', 'zipCode', 'county', 'status', 'listPrice', 'bedrooms', 'bathrooms', 'sqft',
  'isVacant', 'listedDate', 'scrapedAt', 'firstName', 'lastName', 'ownerFullName', 'phone', 'email', 'realtorName',
  'realtorPhone', 'realtorEmail', 'brokerName', 'source', 'previousStatus',
];
const LEAD_SELECTION = LEAD_FIELDS.join(' ');
// Text columns come back as null from SQL; the rest of the app (and the UI) expects '' like before.
const LEAD_TEXT_FIELDS = new Set([
  'address', 'city', 'state', 'zipCode', 'county', 'status', 'firstName', 'lastName', 'ownerFullName', 'phone', 'email',
  'realtorName', 'realtorPhone', 'realtorEmail', 'brokerName', 'source', 'previousStatus', 'scrapedAt', 'listedDate',
]);
function rowToLead(r) {
  const d = { id: r.leadId };
  for (const k of LEAD_FIELDS) {
    if (k === 'leadId') continue;
    d[k] = LEAD_TEXT_FIELDS.has(k) ? (r[k] ?? '') : r[k];
  }
  return d;
}

let leadsSnapshot = { rows: null, loadedAt: 0, loading: null };
function leadsCacheWarm() {
  return Boolean(leadsSnapshot.rows) && Date.now() - leadsSnapshot.loadedAt < LEADS_CACHE_TTL_MS;
}
function invalidateLeadsCache() {
  leadsSnapshot = { rows: null, loadedAt: 0, loading: null };
}
/** All listings as [{ id, d }] sorted by lead id. */
async function getLeadsSnapshot() {
  if (leadsCacheWarm()) return leadsSnapshot.rows;
  if (leadsSnapshot.loading) return leadsSnapshot.loading;
  const loading = (async () => {
    const raw = await sql.pageAll('leads', 'leadId', LEAD_SELECTION);
    const rows = raw.map((r) => ({ id: r.leadId, d: rowToLead(r) }));
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
 * Bulk upsert USA Home Listings. Automatically dedupes by address + zip code (same lead id as before).
 * Only the columns the scraper supplies are written, so owner/contact fields added later are kept.
 */
async function upsertPreMoverLeads(leads = []) {
  if (!Array.isArray(leads) || leads.length === 0) return { inserted: 0, updated: 0 };

  const now = new Date().toISOString();
  const byId = new Map();

  for (const lead of leads) {
    if (!lead.address) continue;
    const addrKeys = buildAddressKeys({
      street: lead.address,
      zip: lead.zipCode || lead.zip_code || lead.zip,
      city: lead.city,
      state: lead.state,
    });
    const leadId = toDocId('lead', addrKeys.primaryKey || `${lead.address}_${lead.zip_code || ''}`);
    byId.set(leadId, {
      leadId,
      address: String(lead.address),
      city: lead.city || '',
      state: lead.state || '',
      zipCode: addrKeys.zip5 || lead.zip_code || lead.zip || '',
      county: lead.county || '',
      status: lead.status || 'for_sale',
      previousStatus: lead.previous_status || lead.previousStatus || '',
      listPrice: Math.round(Number(lead.list_price || lead.listPrice || 0)) || null,
      bedrooms: Math.round(Number(lead.bedrooms || 0)) || null,
      bathrooms: Number(lead.bathrooms || 0) || null,
      sqft: Math.round(Number(lead.sqft || 0)) || null,
      isVacant: Boolean(lead.is_vacant || lead.isVacant),
      listedDate: sql.dateOnly(lead.listed_date || lead.listedDate) || null, // blank = "not supplied"; resolved below
      realtorName: lead.realtor_name || lead.realtorName || '',
      realtorEmail: lead.realtor_email || lead.realtorEmail || '',
      realtorPhone: lead.realtor_phone || lead.realtorPhone || '',
      brokerName: lead.broker_name || lead.brokerName || '',
      source: 'usahomelistings',
      updatedAt: now,
    });
  }

  const rows = [...byId.values()];

  // Listing dates: the portal CSV has no listing date, so a re-upload must never stamp "today" onto leads we
  // already know. Existing leads keep their stored listedDate/scrapedAt; only brand-new leads get today (first seen).
  const existing = new Map();
  for (let i = 0; i < rows.length; i += 500) {
    const ids = rows.slice(i, i + 500).map((r) => r.leadId);
    const data = await sql.read(
      'query E($ids: [String!]!) { leads(where: {leadId: {in: $ids}}) { leadId listedDate scrapedAt status previousStatus } }', { ids });
    for (const e of data.leads || []) existing.set(e.leadId, e);
  }
  for (const r of rows) {
    const prev = existing.get(r.leadId);
    if (prev) {
      // Status change history: when the portal now reports a different status, remember the old one.
      // Otherwise keep whatever was stored (a blank upload value must not wipe it).
      if (prev.status && r.status && prev.status !== r.status) r.previousStatus = prev.status;
      else r.previousStatus = r.previousStatus || prev.previousStatus || '';
      if (prev.listedDate) r.listedDate = prev.listedDate; else if (!r.listedDate) r.listedDate = (prev.scrapedAt || '').slice(0, 10) || now.slice(0, 10);
      // scrapedAt is not written for existing leads, so the original value stays
    } else {
      r.listedDate = r.listedDate || now.slice(0, 10);
      r.scrapedAt = now.slice(0, 19).replace('T', ' ');
    }
  }
  await sql.upsertMany('Lead', 'lead_upsertMany', rows);
  invalidateLeadsCache();
  filteredAnalyticsCache.clear();

  // Match detection for ONLY the listings just ingested. Awaited, not fire-and-forget: a serverless
  // runtime may stop running the moment the response is sent, which would silently drop a background promise.
  const ingested = rows.map((r) => ({ ...r, id: r.leadId }));
  let newMatches = 0;
  try {
    const result = await reconcileMatches({ listings: ingested });
    newMatches = result.newMatchesCount || 0;
  } catch (err) {
    console.error('[leadsDb] Match reconciliation after ingest failed:', err);
  }
  // Analytics are NOT recomputed per chunk (the scraper sends ~40 chunks); it calls
  // POST /api/leads/analytics/refresh once at the end. Just mark the stored copy as stale here.
  try {
    await sql.mergeState('leadsAnalytics', { stale: true });
  } catch (err) {
    console.error('[leadsDb] Could not flag analytics as stale:', err.message);
  }

  return { total: rows.length, newMatches };
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
 * Served from the in-memory snapshot (exact totals, instant page jumps, any filter combination).
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
} = {}) {
  const fetchLimit = Math.min(Math.max(Number(limit) || 50, 10), 200);
  const fetchOffset = Math.max(Number(offset) || 0, 0);
  const filters = { status, state, county, search, minPrice, maxPrice, month };

  const all = await getLeadsSnapshot();
  const filtered = all.filter((r) => listingMatchesFilters(r.d, filters));
  const page = filtered.slice(fetchOffset, fetchOffset + fetchLimit);
  return {
    total: filtered.length,
    leads: page.map((r) => toLeadRow(r.d)),
    offset: fetchOffset,
    limit: fetchLimit,
    endCursor: page.length ? page[page.length - 1].id : null,
    source: 'sql',
  };
}

// ================================================================
// LEGACY CUSTOMERS
// ================================================================

const LEGACY_SELECTION = 'customerId name email phone originAddress destinationAddress city state zipCode moveDate notes importedAt';
function rowToLegacy(r) {
  return {
    id: r.customerId,
    name: r.name || '',
    email: r.email || '',
    phone: r.phone || '',
    originAddress: r.originAddress || '',
    destinationAddress: r.destinationAddress || '',
    city: r.city || '',
    state: r.state || '',
    zip: r.zipCode || '',
    zipCode: r.zipCode || '',
    moveDate: r.moveDate || '',
    notes: r.notes || '',
    importedAt: r.importedAt || null,
  };
}

/**
 * Import historical legacy customer records from CSV/Excel parsing.
 */
async function importLegacyCustomers(customers = []) {
  if (!Array.isArray(customers) || customers.length === 0) return { imported: 0 };

  const now = new Date().toISOString();
  const byId = new Map();
  let seq = 0;
  for (const c of customers) {
    if (!c.name && !c.address && !c.destinationAddress) continue;
    const customerId = toDocId('leg', `${c.name || ''}_${c.destinationAddress || c.address || ''}_${seq++}`);
    byId.set(customerId, {
      customerId,
      name: c.name || c.customerName || 'Customer',
      email: c.email || '',
      phone: c.phone || c.phoneNumber || '',
      originAddress: c.originAddress || c.movingFrom || c.from || '',
      destinationAddress: c.destinationAddress || c.movingTo || c.address || c.to || '',
      city: c.city || '',
      state: c.state || '',
      zipCode: c.zip || c.zipCode || '',
      moveDate: c.moveDate || c.serviceDate || c.date || '',
      notes: c.notes || '',
      importedAt: now,
    });
  }
  const rows = [...byId.values()];
  await sql.upsertMany('LegacyCustomer', 'legacyCustomer_upsertMany', rows);
  pastMovesCache = { index: null, loadedAt: 0 };

  // Run matching after import
  await reconcileMatches();

  return { imported: rows.length };
}

/**
 * List imported legacy customers.
 */
async function listLegacyCustomers(limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 5000);
  const data = await sql.read(`query L { legacyCustomers(limit: ${n}, orderBy: {customerId: ASC}) { ${LEGACY_SELECTION} } }`);
  return (data.legacyCustomers || []).map(rowToLegacy);
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
  const [jobsSnap, legacyRows] = await Promise.all([
    jobsCol.get(),
    sql.pageAll('legacyCustomers', 'customerId', LEGACY_SELECTION),
  ]);
  const jobs = jobsSnap.docs.map((d) => d.data()).filter((j) => j && (j.origin || j.destination));
  const legacyCustomers = legacyRows.map(rowToLegacy);

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

const MATCH_FIELDS = [
  'matchId', 'customerName', 'customerEmail', 'customerPhone', 'matchedAddress', 'matchedType', 'sourceType', 'sourceId',
  'confidence', 'matchReason', 'previousMoveDate', 'previousMoveDetails', 'listingStatus', 'listingPrice', 'listedDate',
  'realtorName', 'realtorPhone', 'realtorEmail', 'status', 'notes', 'outreachHistory', 'detectedAt', 'lastChecked',
  'updatedAt', 'lastOutreachAt',
];
const MATCH_SELECTION = `${MATCH_FIELDS.join(' ')} lead { leadId }`;
function rowToMatch(r) {
  const m = { id: r.matchId, leadId: r.lead ? r.lead.leadId : null };
  for (const k of MATCH_FIELDS) {
    if (k === 'matchId') continue;
    m[k] = r[k];
  }
  m.outreachHistory = Array.isArray(r.outreachHistory) ? r.outreachHistory : [];
  m.notes = r.notes || '';
  return m;
}

/**
 * Matches listings against past customers (booked jobs + legacy customers) and saves matches.
 *  - { listings }: check just those listings (used by ingest).
 *  - no args: "incremental" - only listings added/changed since the last manual run; the very first run,
 *    or { full: true }, checks all listings.
 *  - { dryRun: true }: compute and return counts without writing anything.
 * Existing matches keep their status/notes/outreach history.
 */
async function reconcileMatches({ listings: given, full = false, dryRun = false } = {}) {
  const startedAt = new Date().toISOString();
  let listings = given;
  let mode = 'ingest';

  if (!listings) {
    const state = (await sql.getState('leadsReconcile')) || {};
    const lastRunAt = state.lastRunAt || null;
    if (full || !lastRunAt) {
      mode = 'full';
      listings = (await getLeadsSnapshot()).map((r) => r.d);
    } else {
      mode = 'incremental';
      const raw = await sql.pageAll('leads', 'leadId', LEAD_SELECTION, {
        where: 'updatedAt: {gt: $since}',
        varDefs: ', $since: Timestamp!',
        vars: { since: lastRunAt },
      });
      listings = raw.map(rowToLead);
    }
  }

  if (!listings.length) {
    if (mode !== 'ingest' && !dryRun) {
      await sql.mergeState('leadsReconcile', { lastRunAt: startedAt, lastMode: mode, listingsChecked: 0 });
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
  for (let i = 0; i < uniqueIds.length; i += 200) {
    const ids = uniqueIds.slice(i, i + 200);
    const data = await sql.read(
      `query E($ids: [String!]!) { matchedLeads(limit: 1000, where: {matchId: {in: $ids}}) { ${MATCH_SELECTION} } }`,
      { ids }
    );
    (data.matchedLeads || []).forEach((r) => existingMap.set(r.matchId, rowToMatch(r)));
  }

  // Pass 3: write
  let newMatchesCount = 0;
  const toWrite = new Map();
  for (const { listing, job, type, comp, matchDocId } of candidates) {
    const isLegacy = type === 'legacy';
    const existing = existingMap.get(matchDocId);
    const row = {
      matchId: matchDocId,
      leadLeadId: listing.id,
      sourceType: isLegacy ? 'legacy_customer' : 'smartmoving_job',
      sourceId: job.id ? String(job.id) : null,
      customerName: isLegacy ? (job.name || 'Legacy Customer') : (job.customer || 'Customer'),
      customerEmail: job.email || (existing ? existing.customerEmail : null) || null,
      customerPhone: job.phone || (existing ? existing.customerPhone : null) || null,
      matchedAddress: listing.address,
      matchedType: type,
      previousMoveDate: isLegacy ? (job.moveDate || job.date || null) : (job.date || null),
      previousMoveDetails: isLegacy
        ? `Legacy move recorded on ${job.moveDate || 'past record'}`
        : type === 'moved_to'
          ? `Moved into this property on ${job.date || 'past move'}. Origin: ${job.origin || 'N/A'}`
          : `Moved from this property on ${job.date || 'past move'}. Destination: ${job.destination || 'N/A'}`,
      confidence: Math.round(comp.confidence),
      matchReason: comp.matchReason,
      listingStatus: listing.status,
      listingPrice: listing.listPrice ? Math.round(listing.listPrice) : null,
      listedDate: sql.dateOnly(listing.listedDate),
      realtorName: listing.realtorName || '',
      realtorPhone: listing.realtorPhone || '',
      realtorEmail: listing.realtorEmail || '',
      // Status tracking: default to 'pending' unless already updated by staff
      status: existing ? existing.status : 'pending',
      notes: existing ? existing.notes || '' : '',
      outreachHistory: existing ? existing.outreachHistory || [] : [],
      lastChecked: startedAt,
    };
    if (!existing) {
      row.detectedAt = startedAt;
      if (!toWrite.has(matchDocId)) newMatchesCount++;
    }
    toWrite.set(matchDocId, row);
  }
  if (!dryRun && toWrite.size) await sql.upsertMany('MatchedLead', 'matchedLead_upsertMany', [...toWrite.values()]);

  if (mode !== 'ingest' && !dryRun) {
    await sql.mergeState('leadsReconcile', { lastRunAt: startedAt, lastMode: mode, listingsChecked: listings.length, newMatchesCount });
  }
  console.log(`[leadsDb] Reconcile (${mode}${dryRun ? ', dry run' : ''}): ${listings.length} listings checked, ${candidates.length} candidates, ${newMatchesCount} new matches.`);
  return { newMatchesCount, listingsChecked: listings.length, candidates: candidates.length, mode };
}

/** Manual reconcile throttle: ms until another manual run is allowed (0 = allowed now). */
async function getReconcileCooldownMs() {
  const state = (await sql.getState('leadsReconcile')) || {};
  const last = Date.parse(state.lastManualAt || '');
  if (Number.isNaN(last)) return 0;
  return Math.max(0, last + RECONCILE_COOLDOWN_MS - Date.now());
}
async function markManualReconcile() {
  await sql.mergeState('leadsReconcile', { lastManualAt: new Date().toISOString() });
}

/**
 * List matched leads with status filter.
 */
async function listMatchedLeads(statusFilter) {
  const filtered = statusFilter && statusFilter !== 'all';
  const rows = await sql.pageAll('matchedLeads', 'matchId', MATCH_SELECTION, filtered
    ? { where: 'status: {eq: $status}', varDefs: ', $status: String!', vars: { status: statusFilter } }
    : {});
  const matches = rows.map(rowToMatch);

  // Sort pending first, then by listedDate descending
  matches.sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return (b.listedDate || '').localeCompare(a.listedDate || '');
  });

  return matches;
}

async function getMatch(matchId) {
  const data = await sql.read(`query M($id: String!) { matchedLead(key: {matchId: $id}) { ${MATCH_SELECTION} } }`, { id: matchId });
  return data.matchedLead ? rowToMatch(data.matchedLead) : null;
}

/**
 * Update the review status of a matched lead ('pending' | 'contacted' | 'dismissed' | 'booked').
 */
async function updateMatchedLeadStatus(matchId, status, notes = '') {
  const current = await getMatch(matchId);
  if (!current) {
    throw new Error(`Match not found: ${matchId}`);
  }

  const updates = {
    status,
    updatedAt: new Date().toISOString(),
  };
  if (notes) updates.notes = notes;

  await sql.write('mutation U($id: String!, $d: MatchedLead_Data!) { matchedLead_update(key: {matchId: $id}, data: $d) }', {
    id: matchId,
    d: updates,
  });
  return { id: matchId, status, ...updates };
}

/**
 * Record an outreach action (email sent) on a matched lead.
 */
async function recordOutreach(matchId, outreachRecord) {
  const current = await getMatch(matchId);
  if (!current) {
    throw new Error(`Match not found: ${matchId}`);
  }

  const history = [...(current.outreachHistory || [])];
  history.push({
    ...outreachRecord,
    sentAt: new Date().toISOString(),
  });

  const now = new Date().toISOString();
  await sql.write('mutation O($id: String!, $d: MatchedLead_Data!) { matchedLead_update(key: {matchId: $id}, data: $d) }', {
    id: matchId,
    d: { status: 'contacted', outreachHistory: history, lastOutreachAt: now },
  });

  return { id: matchId, status: 'contacted', outreachHistory: history };
}

let listingCountMemo = { n: 0, at: 0 };
async function countListings() {
  if (leadsCacheWarm()) return leadsSnapshot.rows.length;
  if (Date.now() - listingCountMemo.at < 5 * 60 * 1000) return listingCountMemo.n;
  const keys = await sql.pageAll('leads', 'leadId', 'leadId', { pageSize: 5000 });
  listingCountMemo = { n: keys.length, at: Date.now() };
  return keys.length;
}

/**
 * Get summary KPI metrics for the Leads tab.
 */
async function getLeadsSummary() {
  const [totalListings, matchRows] = await Promise.all([
    countListings(),
    sql.pageAll('matchedLeads', 'matchId', 'matchId status', { pageSize: 5000 }),
  ]);
  const pendingCount = matchRows.filter((m) => m.status === 'pending').length;
  const contactedCount = matchRows.filter((m) => m.status === 'contacted').length;

  return {
    totalListings,
    totalMatches: matchRows.length,
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
  const dailyMap = {}; // keyed by YYYY-MM-DD listing date
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
      dailyMap[dayStr] = (dailyMap[dayStr] || 0) + 1;
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

  // Volume vs. value for the county bubble chart: the 16 busiest counties.
  const countyValue = Object.entries(countyPriceMap)
    .filter(([_, data]) => data.count >= 5)
    .map(([county, data]) => ({ county, avgPrice: Math.round(data.sum / data.count), count: data.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 16);

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

  // Listings per day for the last 150 days (calendar heat map) — sparse: days with none are omitted.
  const dailyCutoff = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10);
  const dailyTrend = Object.fromEntries(Object.entries(dailyMap).filter(([day]) => day >= dailyCutoff));

  // Price histogram: how many listings fall in each price band.
  const PRICE_EDGES = [0, 300000, 400000, 500000, 600000, 700000, 800000, 1000000, 1250000, 1500000, 2000000, Infinity];
  const fmtK = (v) => (v >= 1000000 ? `$${(v / 1000000).toFixed(v % 1000000 ? 2 : 0).replace(/0$/, '')}M` : `$${v / 1000}k`);
  const priceHistogram = PRICE_EDGES.slice(0, -1).map((min, i) => {
    const max = PRICE_EDGES[i + 1];
    return {
      min,
      max: Number.isFinite(max) ? max : null,
      label: i === 0 ? `<${fmtK(max)}` : Number.isFinite(max) ? `${fmtK(min)}–${fmtK(max)}` : `${fmtK(min)}+`,
      count: 0,
    };
  });
  prices.forEach((p) => {
    const idx = PRICE_EDGES.findIndex((edge, i) => p >= edge && p < PRICE_EDGES[i + 1]);
    if (idx >= 0) priceHistogram[idx].count += 1;
  });

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
    countyValue,
    topRealtors,
    weeklyTrend,
    monthlyTrend,
    dailyTrend,
    priceHistogram,
    statusTransitions,
    countyStatusMatrix: countyStatusMap,
    cityStats,
    stateCounties,
    availableStates: Array.from(statesSet).sort(),
    availableCounties: Array.from(countiesSet).sort(),
  };
}


// ---- Analytics: computed over ALL listings at most once a day, stored in the AppState table ----
let analyticsRefreshing = null;
async function refreshLeadsAnalytics({ reload = false } = {}) {
  if (analyticsRefreshing) return analyticsRefreshing;
  if (reload) invalidateLeadsCache(); // pick up rows another instance just ingested
  analyticsRefreshing = (async () => {
    const leads = (await getLeadsSnapshot()).map((r) => r.d);
    const result = computeLeadsAnalytics(leads);
    const computedAt = new Date().toISOString();
    await sql.setState('leadsAnalytics', { computedAt, totalListings: leads.length, result });
    filteredAnalyticsCache.clear();
    return { ...result, computedAt };
  })().finally(() => { analyticsRefreshing = null; });
  return analyticsRefreshing;
}

async function readStoredAnalytics() {
  const stored = await sql.getState('leadsAnalytics');
  if (!stored || !stored.result) return null;
  return { computedAt: stored.computedAt, stale: Boolean(stored.stale), result: { ...stored.result, computedAt: stored.computedAt } };
}

/** Returns the stored analytics when fresh (< 24h); otherwise recomputes over all listings. */
/** True when any listing was written after the stored analytics were computed (e.g. an upload whose chart refresh never ran). */
async function leadsChangedSince(computedAt) {
  try {
    const d = await sql.read('query N { leads(limit: 1, orderBy: {updatedAt: DESC}) { updatedAt } }');
    const newest = d.leads && d.leads[0] ? d.leads[0].updatedAt : null;
    return Boolean(newest && computedAt && Date.parse(newest) > Date.parse(computedAt));
  } catch (e) {
    return false;
  }
}

const filteredAnalyticsCache = new Map(); // JSON(filters) -> { at, result }
async function getLeadsAnalytics({ refresh = false, filters = null } = {}) {
  // Any filter -> compute over just the matching listings (2-minute memo; the snapshot is already in memory).
  if (filters && Object.values(filters).some((v) => v !== undefined && v !== '' && v !== 'all')) {
    const key = JSON.stringify(filters);
    const hit = filteredAnalyticsCache.get(key);
    if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.result;
    const rows = (await getLeadsSnapshot()).filter((r) => listingMatchesFilters(r.d, filters)).map((r) => r.d);
    const result = { ...computeLeadsAnalytics(rows), filtered: true, matchingListings: rows.length };
    if (filteredAnalyticsCache.size > 50) filteredAnalyticsCache.clear();
    filteredAnalyticsCache.set(key, { at: Date.now(), result });
    return result;
  }
  if (!refresh) {
    const stored = await readStoredAnalytics();
    if (stored && !stored.stale && (await leadsChangedSince(stored.computedAt))) stored.stale = true;
    // A stored summary from before monthlyTrend existed is treated as stale so the new charts fill in.
    if (stored && stored.result && !stored.stale && stored.result.monthlyTrend && stored.result.priceHistogram && Date.now() - Date.parse(stored.computedAt) < ANALYTICS_TTL_MS) return stored.result;
  }
  return refreshLeadsAnalytics();
}

async function refreshLeadsAnalyticsIfStale() {
  const stored = await readStoredAnalytics();
  if (stored && Date.now() - Date.parse(stored.computedAt) < ANALYTICS_INGEST_REFRESH_MS) return false;
  await refreshLeadsAnalytics();
  return true;
}

/**
 * Headline numbers for whatever filters are applied (the KPI cards): totals by status, average and
 * median price, and how many VIP customer matches belong to those listings.
 */
async function getFilteredStats(filters = {}) {
  const all = await getLeadsSnapshot();
  const rows = all.filter((r) => listingMatchesFilters(r.d, filters));
  const byStatus = {};
  const prices = [];
  const addresses = new Set();
  for (const r of rows) {
    const st = r.d.status || 'for_sale';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const p = Number(r.d.listPrice);
    if (p > 0) prices.push(p);
    if (r.d.address) addresses.add(String(r.d.address).toLowerCase());
  }
  prices.sort((a, b) => a - b);
  const avgPrice = prices.length ? Math.round(prices.reduce((s, p) => s + p, 0) / prices.length) : 0;
  const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : 0;

  const matchRows = await sql.pageAll('matchedLeads', 'matchId', 'matchId matchedAddress status', { pageSize: 5000 });
  let matchTotal = 0;
  let matchPending = 0;
  matchRows.forEach((m) => {
    if (addresses.has(String(m.matchedAddress || '').toLowerCase())) {
      matchTotal += 1;
      if (m.status === 'pending') matchPending += 1;
    }
  });

  return {
    total: rows.length,
    forSale: byStatus.for_sale || 0,
    underContract: byStatus.under_contract || 0,
    pending: byStatus.pending || 0,
    closed: byStatus.closed || 0,
    avgPrice,
    medianPrice,
    matches: { total: matchTotal, pending: matchPending },
  };
}

const CSV_COLUMNS = [
  ['id', 'Lead ID'], ['status', 'Status'], ['listedDate', 'Listed date'], ['address', 'Address'], ['city', 'City'],
  ['state', 'State'], ['zipCode', 'ZIP'], ['county', 'County'], ['listPrice', 'List price'], ['bedrooms', 'Beds'],
  ['bathrooms', 'Baths'], ['sqft', 'Sq ft'], ['ownerFullName', 'Owner'], ['phone', 'Owner phone'], ['email', 'Owner email'],
  ['realtorName', 'Realtor'], ['realtorPhone', 'Realtor phone'], ['realtorEmail', 'Realtor email'], ['brokerName', 'Broker'],
];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Spreadsheet-formula injection guard: a cell starting with = + - @ would run as a formula in Excel.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Every listing matching the filters as CSV (opens in Excel). Served from the cached snapshot. */
async function exportListingsCsv(filters = {}) {
  const all = await getLeadsSnapshot();
  const rows = all.filter((r) => listingMatchesFilters(r.d, filters));
  const lines = [CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([key]) => csvCell(r.d[key])).join(','));
  return { csv: `\ufeff${lines.join('\r\n')}\r\n`, count: rows.length };
}

module.exports = {
  getFilteredStats,
  exportListingsCsv,
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
