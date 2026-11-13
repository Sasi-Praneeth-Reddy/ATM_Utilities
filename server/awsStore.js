/**
 * server/awsStore.js
 *
 * Data store for the Leads and Storage-market data, on AWS DynamoDB. Replaces sqlconnect.js (Firebase SQL
 * Connect / Cloud SQL), which cost ~$9.50/month for an always-on Postgres server. The scheduler's own
 * data (jobs, trucks, drivers, users) stays in Firestore - this file never touches it.
 *
 * WHY DYNAMODB (and not Postgres): the app never needed SQL. leadsDb.js loads all ~27K listings into
 * memory and filters/searches/counts there; storageDb.js pre-computes its dashboards once a day. So the
 * store only needs get / put / scan / a few indexed lookups, which DynamoDB does for about $0-1/month.
 *
 * TABLES (see TABLE_DEFS below; names are `${ATM_DDB_PREFIX}${table}`, prefix defaults to "atm-"):
 *   atm-leads, atm-matched-leads, atm-legacy-customers, atm-storage-facilities, atm-storage-pricing,
 *   atm-mls-benchmarks, atm-scrape-runs, atm-email-notices, atm-app-state
 * The same definitions generate the CloudFormation template (scripts/make-aws-template.js), so the code
 * and the real tables cannot drift apart.
 *
 * CONFIG (env):
 *   ATM_AWS_REGION              default us-east-1
 *   ATM_AWS_ACCESS_KEY_ID /
 *   ATM_AWS_SECRET_ACCESS_KEY   credentials of the atm-data-writer IAM user (Firebase secrets in production).
 *                               If unset, the normal AWS credential chain is used (aws configure, SSO, a Lambda role).
 *   ATM_DDB_PREFIX              table-name prefix, default "atm-" (use "atm-stg-" for a staging copy)
 *   ATM_DYNAMODB_ENDPOINT       local emulator URL (tests only)
 *
 * BEHAVIOUR THAT MATTERS
 *  - upsertMany MERGES into an existing item (columns you do not send are kept, an explicit null overwrites),
 *    exactly like the old SQL upsert. The ingest relies on this: re-uploading a listing must not wipe the
 *    owner/contact fields added later.
 *  - Rows come back with EVERY declared field present (null when never set), like SQL did, so the UI and
 *    the matching code see the same shapes as before. Internal index attributes are never returned.
 *  - Dates are stored as 'YYYY-MM-DD' and timestamps as ISO-8601 UTC strings, so string comparison sorts correctly.
 *  - AppState values are JSON, gzip-compressed into one binary attribute (DynamoDB items max out at 400 KB;
 *    the big analytics/summary documents are ~400 KB raw but ~40 KB gzipped).
 *  - Reads of single items / state use ConsistentRead. Scans are eventually consistent (fine: they feed
 *    caches that are minutes old anyway).
 */
require('./load-env');
const zlib = require('zlib');
const {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand,
  BatchGetCommand, BatchWriteCommand, ScanCommand, QueryCommand,
} = require('@aws-sdk/lib-dynamodb');

/* ------------------------------------------------------------------------------------------------
 * Table definitions (single source of truth)
 * ---------------------------------------------------------------------------------------------- */
const TABLE_DEFS = {
  Lead: {
    table: 'leads', key: 'leadId', scanSegments: 4, hasCreatedAt: true,
    fields: [
      'leadId', 'address', 'city', 'state', 'zipCode', 'county', 'status', 'listPrice', 'bedrooms', 'bathrooms', 'sqft',
      'isVacant', 'listedDate', 'scrapedAt', 'firstName', 'lastName', 'ownerFullName', 'phone', 'email', 'realtorName',
      'realtorPhone', 'realtorEmail', 'brokerName', 'source', 'previousStatus', 'updatedAt', 'createdAt',
    ],
    dates: ['listedDate'], timestamps: ['updatedAt', 'createdAt'],
  },
  MatchedLead: {
    table: 'matched-leads', key: 'matchId',
    fields: [
      'matchId', 'leadId', 'customerName', 'customerEmail', 'customerPhone', 'matchedAddress', 'matchedType', 'sourceType',
      'sourceId', 'confidence', 'matchReason', 'previousMoveDate', 'previousMoveDetails', 'listingStatus', 'listingPrice',
      'listedDate', 'realtorName', 'realtorPhone', 'realtorEmail', 'status', 'notes', 'outreachHistory', 'detectedAt',
      'lastChecked', 'updatedAt', 'lastOutreachAt',
    ],
    dates: ['listedDate'], timestamps: ['detectedAt', 'lastChecked', 'updatedAt', 'lastOutreachAt'],
  },
  LegacyCustomer: {
    table: 'legacy-customers', key: 'customerId',
    fields: ['customerId', 'name', 'email', 'phone', 'originAddress', 'destinationAddress', 'city', 'state', 'zipCode', 'moveDate', 'notes', 'importedAt'],
    dates: [], timestamps: ['importedAt'],
  },
  StorageFacility: {
    table: 'storage-facilities', key: 'facilityId',
    fields: ['facilityId', 'name', 'brand', 'address', 'city', 'state', 'zipCode', 'lat', 'lon', 'phone', 'website'],
    dates: [], timestamps: [],
  },
  StoragePricing: {
    // Price history grows every day, so it has two indexes: byDay (the dashboard summary reads the last 30 days)
    // and byFacilityUnit (the price-history chart for one facility + unit size). `day` and `fu` are internal
    // attributes derived on every write; they are never returned.
    table: 'storage-pricing', key: 'priceId', scanSegments: 4,
    fields: ['priceId', 'facilityId', 'unitSize', 'unitType', 'streetRate', 'webRate', 'availability', 'source', 'scrapedAt'],
    dates: [], timestamps: ['scrapedAt'],
    gsis: [
      { name: 'byDay', pk: 'day', sk: 'scrapedAt' },
      { name: 'byFacilityUnit', pk: 'fu', sk: 'scrapedAt' },
    ],
    internal: ['day', 'fu'],
    derive: (it) => ({
      day: it.scrapedAt ? String(it.scrapedAt).slice(0, 10) : undefined,
      fu: it.facilityId !== undefined && it.unitSize !== undefined ? `${it.facilityId}#${it.unitSize}` : undefined,
    }),
  },
  MlsBenchmark: {
    table: 'mls-benchmarks', key: 'benchmarkId',
    fields: [
      'benchmarkId', 'region', 'source', 'periodType', 'periodDate', 'year', 'month', 'activeListings', 'newListings',
      'closedSales', 'pendingSales', 'avgClosePrice', 'medianClosePrice', 'medianDaysOnMarket', 'closeToListRatio',
    ],
    dates: ['periodDate'], timestamps: [],
  },
  ScrapeRun: {
    table: 'scrape-runs', key: 'runId',
    fields: ['runId', 'source', 'status', 'recordsWritten', 'errorMessage', 'durationSec', 'runAt'],
    dates: [], timestamps: ['runAt'],
  },
  EmailNotice: {
    table: 'email-notices', key: 'noticeId',
    fields: ['noticeId', 'recipients', 'subject', 'status', 'errorMessage', 'messageId', 'sentAt'],
    dates: [], timestamps: ['sentAt'],
  },
  AppState: { table: 'app-state', key: 'stateKey', special: true, fields: ['stateKey', 'value', 'updatedAt'], dates: [], timestamps: ['updatedAt'] },
};

const defOf = (type) => {
  const d = TABLE_DEFS[type];
  if (!d) throw new Error(`awsStore: unknown table type "${type}"`);
  return d;
};
const prefix = () => (process.env.ATM_DDB_PREFIX !== undefined ? process.env.ATM_DDB_PREFIX : 'atm-');
const tableName = (type) => `${prefix()}${defOf(type).table}`;

/** What CloudFormation / the local emulator need to create a table (without the table name). */
function tableSpec(type) {
  const d = defOf(type);
  const attrs = new Map([[d.key, 'S']]);
  for (const g of d.gsis || []) { attrs.set(g.pk, 'S'); attrs.set(g.sk, 'S'); }
  return {
    AttributeDefinitions: [...attrs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })),
    KeySchema: [{ AttributeName: d.key, KeyType: 'HASH' }],
    GlobalSecondaryIndexes: (d.gsis || []).map((g) => ({
      IndexName: g.name,
      KeySchema: [{ AttributeName: g.pk, KeyType: 'HASH' }, { AttributeName: g.sk, KeyType: 'RANGE' }],
      Projection: { ProjectionType: 'ALL' },
    })),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Client
 * ---------------------------------------------------------------------------------------------- */
let rawClientInstance = null;
let docClientInstance = null;
function clientConfig() {
  const cfg = { region: process.env.ATM_AWS_REGION || 'us-east-1', maxAttempts: 6 };
  if (process.env.ATM_AWS_ACCESS_KEY_ID && process.env.ATM_AWS_SECRET_ACCESS_KEY) {
    cfg.credentials = { accessKeyId: process.env.ATM_AWS_ACCESS_KEY_ID, secretAccessKey: process.env.ATM_AWS_SECRET_ACCESS_KEY };
  }
  if (process.env.ATM_DYNAMODB_ENDPOINT) {
    cfg.endpoint = process.env.ATM_DYNAMODB_ENDPOINT;
    cfg.credentials = cfg.credentials || { accessKeyId: 'local', secretAccessKey: 'local' };
  }
  return cfg;
}
function raw() {
  if (!rawClientInstance) rawClientInstance = new DynamoDBClient(clientConfig());
  return rawClientInstance;
}
function client() {
  if (!docClientInstance) docClientInstance = DynamoDBDocumentClient.from(raw(), { marshallOptions: { removeUndefinedValues: true } });
  return docClientInstance;
}
/** Tests only: forget the cached clients (after changing env vars). */
function _resetClients() { rawClientInstance = null; docClientInstance = null; }

/* ------------------------------------------------------------------------------------------------
 * Value helpers (same behaviour as the old sqlconnect.js)
 * ---------------------------------------------------------------------------------------------- */
const nn = (v) => (v === undefined || v === null || v === '' ? null : v);
function dateOnly(v) {
  const s = nn(v) === null ? null : String(v);
  const m = s && s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function isoTs(v) {
  if (nn(v) === null) return null;
  const s = String(v).trim();
  const d = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z')) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(2000, 50 * 2 ** attempt) + Math.floor(Math.random() * 50);

/** Runs async task functions with at most `limit` in flight. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Copy of a row with dates/timestamps normalised and undefined values dropped. */
function normalizeRow(def, row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (v === undefined) continue;
    if (v === null) { out[k] = null; continue; }
    if (def.dates.includes(k)) out[k] = dateOnly(v);
    else if (def.timestamps.includes(k)) out[k] = isoTs(v);
    else out[k] = v;
  }
  return out;
}

/** A stored item as the app sees it: every declared field present (null if absent), no internal attributes. */
function fillRow(def, item) {
  const out = {};
  for (const f of def.fields) out[f] = item[f] === undefined ? null : item[f];
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------------------------------- */
/** Filter builders for scan(): store.scan('Lead', { filter: store.gt('updatedAt', since) }). */
const cmp = (op) => (attr, value) => ({ expr: `#f ${op} :v`, names: { '#f': attr }, values: { ':v': value } });
const filters = { eq: cmp('='), gt: cmp('>'), ge: cmp('>='), lt: cmp('<'), le: cmp('<=') };

/**
 * Reads every row of a table, sorted by its key (the old keyset paging returned key order too).
 *   opts.filter   - one of the filters above (applied by DynamoDB; the whole table is still read and billed)
 *   opts.project  - array of attribute names; rows then contain ONLY those (no null-filling)
 */
async function scan(type, { filter = null, project = null } = {}) {
  const def = defOf(type);
  const TableName = tableName(type);
  const segs = Math.max(1, Number(process.env.ATM_DDB_SCAN_SEGMENTS) || def.scanSegments || 1);

  const runSegment = async (segment) => {
    const items = [];
    let ExclusiveStartKey;
    do {
      const params = { TableName, ExclusiveStartKey };
      if (segs > 1) { params.Segment = segment; params.TotalSegments = segs; }
      const names = {};
      if (filter) {
        params.FilterExpression = filter.expr;
        Object.assign(names, filter.names);
        params.ExpressionAttributeValues = filter.values;
      }
      if (project) {
        project.forEach((a, i) => { names[`#p${i}`] = a; });
        params.ProjectionExpression = project.map((_, i) => `#p${i}`).join(', ');
      }
      if (Object.keys(names).length) params.ExpressionAttributeNames = names;
      const res = await client().send(new ScanCommand(params));
      items.push(...(res.Items || []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };

  const parts = await Promise.all(Array.from({ length: segs }, (_, i) => runSegment(i)));
  const rows = parts.flat();
  rows.sort((a, b) => (String(a[def.key]) < String(b[def.key]) ? -1 : String(a[def.key]) > String(b[def.key]) ? 1 : 0));
  return project ? rows : rows.map((r) => fillRow(def, r));
}

/** Number of rows (reads the table but transfers no items). */
async function count(type) {
  const def = defOf(type);
  const segs = Math.max(1, Number(process.env.ATM_DDB_SCAN_SEGMENTS) || def.scanSegments || 1);
  const one = async (segment) => {
    let n = 0; let ExclusiveStartKey;
    do {
      const params = { TableName: tableName(type), Select: 'COUNT', ExclusiveStartKey };
      if (segs > 1) { params.Segment = segment; params.TotalSegments = segs; }
      const res = await client().send(new ScanCommand(params));
      n += res.Count || 0; ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return n;
  };
  return (await Promise.all(Array.from({ length: segs }, (_, i) => one(i)))).reduce((a, b) => a + b, 0);
}

async function getItemRaw(type, id) {
  const def = defOf(type);
  const res = await client().send(new GetCommand({ TableName: tableName(type), Key: { [def.key]: String(id) }, ConsistentRead: true }));
  return res.Item || null;
}
/** One row by key, or null. */
async function getItem(type, id) {
  const item = await getItemRaw(type, id);
  return item ? fillRow(defOf(type), item) : null;
}

async function getManyRaw(type, ids) {
  const def = defOf(type);
  const TableName = tableName(type);
  const uniq = [...new Set((ids || []).map(String))];
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 100) chunks.push(uniq.slice(i, i + 100));
  const parts = await pool(chunks.map((chunk) => async () => {
    const found = [];
    let keys = chunk.map((id) => ({ [def.key]: id }));
    for (let attempt = 0; keys.length; attempt++) {
      if (attempt > 8) throw new Error(`awsStore: BatchGet on ${TableName} kept returning unprocessed keys`);
      if (attempt) await sleep(backoff(attempt));
      const res = await client().send(new BatchGetCommand({ RequestItems: { [TableName]: { Keys: keys, ConsistentRead: true } } }));
      found.push(...((res.Responses && res.Responses[TableName]) || []));
      keys = (res.UnprocessedKeys && res.UnprocessedKeys[TableName] && res.UnprocessedKeys[TableName].Keys) || [];
    }
    return found;
  }), 4);
  return parts.flat();
}
/** Rows for a list of keys (missing keys are simply absent from the result). */
async function getMany(type, ids) {
  const def = defOf(type);
  return (await getManyRaw(type, ids)).map((it) => fillRow(def, it));
}

/* ------------------------------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------------------------------- */
async function batchWrite(TableName, requests) {
  const chunks = [];
  for (let i = 0; i < requests.length; i += 25) chunks.push(requests.slice(i, i + 25));
  await pool(chunks.map((chunk) => async () => {
    let pending = chunk;
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt > 8) throw new Error(`awsStore: BatchWrite on ${TableName} kept returning unprocessed items`);
      if (attempt) await sleep(backoff(attempt));
      const res = await client().send(new BatchWriteCommand({ RequestItems: { [TableName]: pending } }));
      pending = (res.UnprocessedItems && res.UnprocessedItems[TableName]) || [];
    }
  }), 5);
}

/**
 * Inserts or updates rows, MERGING into any existing row (see file header). Returns how many rows were written.
 * Replaces the old `upsertMany(typeName, mutationName, rows)`.
 */
async function upsertMany(type, rows) {
  const def = defOf(type);
  const byKey = new Map();
  for (const r of rows || []) {
    const k = r && r[def.key] !== undefined && r[def.key] !== null ? String(r[def.key]) : '';
    if (!k) continue;
    byKey.set(k, { ...(byKey.get(k) || {}), ...normalizeRow(def, r), [def.key]: k });
  }
  if (!byKey.size) return 0;
  const existing = new Map((await getManyRaw(type, [...byKey.keys()])).map((it) => [String(it[def.key]), it]));
  const now = new Date().toISOString();
  const requests = [...byKey].map(([k, r]) => {
    const merged = { ...(existing.get(k) || {}), ...r };
    if (def.hasCreatedAt && !merged.createdAt) merged.createdAt = now;
    if (def.derive) Object.assign(merged, def.derive(merged));
    return { PutRequest: { Item: merged } };
  });
  await batchWrite(tableName(type), requests);
  return requests.length;
}

/** Writes rows exactly as given (no merge). Used by the one-time copy from Cloud SQL. */
async function putMany(type, rows) {
  const def = defOf(type);
  const requests = (rows || []).map((r) => {
    const item = normalizeRow(def, r);
    if (def.derive) Object.assign(item, def.derive(item));
    return { PutRequest: { Item: item } };
  });
  if (requests.length) await batchWrite(tableName(type), requests);
  return requests.length;
}

/** Changes only the given columns of an EXISTING row. Throws if the row does not exist. */
async function update(type, id, patch) {
  const def = defOf(type);
  const names = { '#pk': def.key };
  const values = {};
  const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(normalizeRow(def, patch))) {
    names[`#a${i}`] = k; values[`:v${i}`] = v; sets.push(`#a${i} = :v${i}`); i++;
  }
  if (!sets.length) return;
  try {
    await client().send(new UpdateCommand({
      TableName: tableName(type), Key: { [def.key]: String(id) },
      UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: 'attribute_exists(#pk)',
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (err && err.name === 'ConditionalCheckFailedException') throw new Error(`Not found: ${type} ${id}`);
    throw err;
  }
}

/** Deletes every row of a table. Returns how many. */
async function deleteAll(type) {
  const def = defOf(type);
  const keys = await scan(type, { project: [def.key] });
  await batchWrite(tableName(type), keys.map((k) => ({ DeleteRequest: { Key: { [def.key]: k[def.key] } } })));
  return keys.length;
}

/* ------------------------------------------------------------------------------------------------
 * Storage pricing (indexed lookups)
 * ---------------------------------------------------------------------------------------------- */
async function queryPages(params, onPage) {
  let ExclusiveStartKey;
  do {
    const res = await client().send(new QueryCommand({ ...params, ExclusiveStartKey }));
    if (res.Items && res.Items.length) await onPage(res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}
const todayUtc = () => new Date().toISOString().slice(0, 10);
const addDaysUtc = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Price rows of one facility + unit size since `sinceIso`, oldest first (max 5000, like the old query). */
async function pricingHistory(facilityId, unitSize, sinceIso) {
  const def = defOf('StoragePricing');
  const rows = [];
  await queryPages({
    TableName: tableName('StoragePricing'), IndexName: 'byFacilityUnit',
    KeyConditionExpression: '#fu = :fu AND #s >= :s',
    ExpressionAttributeNames: { '#fu': 'fu', '#s': 'scrapedAt' },
    ExpressionAttributeValues: { ':fu': `${facilityId}#${unitSize}`, ':s': isoTs(sinceIso) || sinceIso },
    ScanIndexForward: true,
  }, (items) => { rows.push(...items.map((it) => fillRow(def, it))); });
  return rows.slice(0, 5000);
}

/** Streams every price row scraped at/after `sinceIso`, one page at a time, to onPage(rows). */
async function pricingSince(sinceIso, onPage) {
  const def = defOf('StoragePricing');
  const since = isoTs(sinceIso) || sinceIso;
  const last = todayUtc();
  let day = String(since).slice(0, 10);
  for (let guard = 0; day <= last && guard < 800; guard++, day = addDaysUtc(day, 1)) {
    await queryPages({
      TableName: tableName('StoragePricing'), IndexName: 'byDay',
      KeyConditionExpression: '#d = :d AND #s >= :s',
      ExpressionAttributeNames: { '#d': 'day', '#s': 'scrapedAt' },
      ExpressionAttributeValues: { ':d': day, ':s': since },
    }, (items) => onPage(items.map((it) => fillRow(def, it))));
  }
}

/** Timestamp of the most recent price row, or null when there are none. */
async function newestPricingAt() {
  const TableName = tableName('StoragePricing');
  const probe = await client().send(new ScanCommand({ TableName, Limit: 1 }));
  if (!probe.Items || !probe.Items.length) return null;
  let day = todayUtc();
  for (let i = 0; i < 120; i++, day = addDaysUtc(day, -1)) {
    const res = await client().send(new QueryCommand({
      TableName, IndexName: 'byDay', KeyConditionExpression: '#d = :d',
      ExpressionAttributeNames: { '#d': 'day' }, ExpressionAttributeValues: { ':d': day },
      ScanIndexForward: false, Limit: 1,
    }));
    if (res.Items && res.Items.length) return res.Items[0].scrapedAt;
  }
  // Nothing in the last 120 days: fall back to reading the table.
  const all = await scan('StoragePricing', { project: ['scrapedAt'] });
  return all.reduce((m, r) => (r.scrapedAt && r.scrapedAt > m ? r.scrapedAt : m), '') || null;
}

/* ------------------------------------------------------------------------------------------------
 * Small key/value store for cached analytics, reconcile state, id maps (replaces AppState in SQL)
 * ---------------------------------------------------------------------------------------------- */
const STATE_MAX_BYTES = 380 * 1024;
function encodeState(key, value) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(value === undefined ? null : value)));
  if (gz.length > STATE_MAX_BYTES) {
    throw new Error(`awsStore: state "${key}" is ${gz.length} bytes compressed; DynamoDB items are limited to 400 KB. Store it in S3 instead.`);
  }
  return gz;
}
const decodeState = (item) => JSON.parse(zlib.gunzipSync(Buffer.from(item.z)).toString('utf8'));

async function getState(key) {
  const item = await getItemRaw('AppState', key);
  return item && item.z ? decodeState(item) : null;
}
async function setState(key, value) {
  await client().send(new PutCommand({
    TableName: tableName('AppState'),
    Item: { stateKey: String(key), z: encodeState(key, value), updatedAt: new Date().toISOString() },
  }));
}
/** Shallow-merge into an object-valued state entry. */
async function mergeState(key, patch) {
  const cur = (await getState(key)) || {};
  const next = { ...(cur && typeof cur === 'object' ? cur : {}), ...patch };
  await setState(key, next);
  return next;
}
async function deleteState(key) {
  await client().send(new DeleteCommand({ TableName: tableName('AppState'), Key: { stateKey: String(key) } }));
}
/** Every state entry as { stateKey, value, updatedAt } (for the copy / verify scripts). */
async function listStates() {
  const items = await scan('AppState', { project: ['stateKey', 'z', 'updatedAt'] });
  return items.map((it) => ({ stateKey: it.stateKey, value: it.z ? decodeState(it) : null, updatedAt: it.updatedAt || null }));
}
/** Writes a state entry together with its original updatedAt (copy script). */
async function putState(key, value, updatedAt) {
  await client().send(new PutCommand({
    TableName: tableName('AppState'),
    Item: { stateKey: String(key), z: encodeState(key, value), updatedAt: isoTs(updatedAt) || new Date().toISOString() },
  }));
}

/* ------------------------------------------------------------------------------------------------
 * Local emulator helper (tests): creates all tables if missing.
 * ---------------------------------------------------------------------------------------------- */
async function createTablesIfMissing() {
  for (const type of Object.keys(TABLE_DEFS)) {
    const TableName = tableName(type);
    try { await raw().send(new DescribeTableCommand({ TableName })); continue; } catch (e) { if (e.name !== 'ResourceNotFoundException') throw e; }
    const spec = tableSpec(type);
    const params = { TableName, BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: spec.AttributeDefinitions, KeySchema: spec.KeySchema };
    if (spec.GlobalSecondaryIndexes.length) params.GlobalSecondaryIndexes = spec.GlobalSecondaryIndexes;
    await raw().send(new CreateTableCommand(params));
  }
}

module.exports = {
  TABLE_DEFS, tableName, tableSpec, fillRow, normalizeRow,
  scan, count, getItem, getMany, upsertMany, putMany, update, deleteAll,
  eq: filters.eq, gt: filters.gt, ge: filters.ge, lt: filters.lt, le: filters.le,
  pricingHistory, pricingSince, newestPricingAt,
  getState, setState, mergeState, deleteState, listStates, putState,
  dateOnly, isoTs,
  createTablesIfMissing, _resetClients,
};
