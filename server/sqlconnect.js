/**
 * server/sqlconnect.js
 *
 * Thin helper around Firebase SQL Connect (Cloud SQL for PostgreSQL) used by the Leads and Storage
 * data layers. The scheduler's own data (trucks, drivers, jobs, users) stays in Firestore - this is
 * only for the large, relational Leads / Storage-market data sets.
 *
 * Service: atm-scheduler-service (us-east4). Schema lives in /dataconnect/schema/schema.gql.
 *
 * Auth: re-uses the Firebase Admin app created in ./firestore (same service account / ADC). That
 * identity needs permission to call SQL Connect (role "Firebase Data Connect Admin" or equivalent,
 * plus "Cloud SQL Client"). Local emulator: set DATA_CONNECT_EMULATOR_HOST.
 */

require('./firestore'); // makes sure the default Firebase Admin app exists
const { getDataConnect } = require('firebase-admin/data-connect');

const SERVICE_ID = process.env.SQL_CONNECT_SERVICE_ID || 'atm-scheduler-service';
const LOCATION = process.env.SQL_CONNECT_LOCATION || 'us-east4';
const WRITE_BATCH = 100; // SQL Connect rejects *_upsertMany payloads larger than 100 rows

let client = null;
function dc() {
  if (!client) client = getDataConnect({ serviceId: SERVICE_ID, location: LOCATION });
  return client;
}

async function read(query, variables) {
  const res = await dc().executeGraphqlRead(query, variables ? { variables } : undefined);
  return res.data;
}

async function write(query, variables) {
  const res = await dc().executeGraphql(query, variables ? { variables } : undefined);
  return res.data;
}

/**
 * Reads every row of a table with keyset paging (stable, no OFFSET cost).
 *   field     - generated list query name, e.g. 'leads'
 *   pk        - primary key column used for ordering/paging, e.g. 'leadId'
 *   selection - GraphQL selection, e.g. 'leadId address city'
 *   opts.where    - extra where fragment WITHOUT braces, e.g. 'status: {eq: $status}'
 *   opts.varDefs  - extra variable definitions, e.g. ', $status: String!'
 *   opts.vars     - values for those variables
 */
async function pageAll(field, pk, selection, { where = '', varDefs = '', vars = {}, pageSize = 2000 } = {}) {
  const out = [];
  let after = null;
  for (;;) {
    const parts = [];
    if (after !== null) parts.push(`${pk}: {gt: $after}`);
    if (where) parts.push(where);
    const w = parts.length ? `, where: {${parts.join(', ')}}` : '';
    const q = `query Page($after: String${varDefs}) { ${field}(limit: ${pageSize}, orderBy: {${pk}: ASC}${w}) { ${selection} } }`;
    const data = await read(q, after !== null ? { ...vars, after } : { ...vars });
    const rows = data[field] || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1][pk];
  }
  return out;
}

/** Upserts rows in <=100-row batches. `mutation` is the generated name, e.g. 'lead_upsertMany'. */
async function upsertMany(typeName, mutation, rows) {
  const q = `mutation Up($data: [${typeName}_Data!]!) { ${mutation}(data: $data) }`;
  let n = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const data = rows.slice(i, i + WRITE_BATCH);
    await write(q, { data });
    n += data.length;
  }
  return n;
}

// ---- small key/value store (replaces the cached Firestore `system/*` documents) ----
async function getState(key) {
  const data = await read('query S($k: String!) { appState(key: {stateKey: $k}) { value updatedAt } }', { k: key });
  return data.appState ? data.appState.value : null;
}
async function setState(key, value) {
  await write('mutation S($d: AppState_Data!) { appState_upsert(data: $d) }', {
    d: { stateKey: key, value, updatedAt: new Date().toISOString() },
  });
}
/** Shallow-merge into an object-valued state entry. */
async function mergeState(key, patch) {
  const cur = (await getState(key)) || {};
  const next = { ...(cur && typeof cur === 'object' ? cur : {}), ...patch };
  await setState(key, next);
  return next;
}

// ---- value helpers ----
const nn = (v) => (v === undefined || v === null || v === '' ? null : v);
function dateOnly(v) {
  const s = nn(v) === null ? null : String(v);
  const m = s && s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function isoTs(v) {
  if (nn(v) === null) return null;
  const s = String(v).trim();
  const d = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? new Date(s.replace(' ', 'T') + 'Z') : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { read, write, pageAll, upsertMany, getState, setState, mergeState, dateOnly, isoTs, WRITE_BATCH };
