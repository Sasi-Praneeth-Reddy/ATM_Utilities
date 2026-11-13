/**
 * server/lambda.js - AWS Lambda entry point (replaces the Cloud Functions wrappers in functions-index.js).
 *
 * One Lambda runs everything:
 *  - HTTP: a Lambda Function URL (payload format 2.0) forwards every request to server.js's handleRequest(),
 *    the same plain Node (req, res) handler Cloud Functions used. A Function URL (not API Gateway) is used
 *    on purpose: API Gateway cuts requests off at 30 s, the leads ingest and exports can run longer.
 *  - Scheduled jobs: EventBridge Scheduler invokes the same function with { "job": "<name>" }
 *    (pollSweep | materials | smartInsights | calendar), mirroring the scheduled functions in functions-index.js.
 *
 * Configuration: every value (secrets and plain settings) lives in SSM Parameter Store under
 * ATM_SSM_PREFIX (default /atm/prod/), one parameter per environment-variable name, e.g.
 * /atm/prod/SESSION_SECRET. They are loaded once per cold start into process.env BEFORE server.js is required,
 * because firestore.js and others read their settings at require time. Firestore itself stays on Google:
 * set FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON (see firestore.js). DynamoDB (leads/storage)
 * needs no keys here - the Lambda's IAM role is used.
 *
 * Local tests: ATM_SKIP_SSM=1 skips the SSM load (see test-lambda.js).
 */
'use strict';

const SSM_PREFIX = process.env.ATM_SSM_PREFIX || '/atm/prod/';

async function loadConfig() {
  if (process.env.ATM_SKIP_SSM === '1') return;
  const { SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');
  const ssm = new SSMClient({});
  let next;
  do {
    const r = await ssm.send(new GetParametersByPathCommand({ Path: SSM_PREFIX, Recursive: true, WithDecryption: true, NextToken: next }));
    for (const p of r.Parameters || []) {
      const name = p.Name.slice(SSM_PREFIX.length);
      if (name && process.env[name] === undefined) process.env[name] = p.Value; // real env vars win (handy for overrides)
    }
    next = r.NextToken;
  } while (next);
}

let app = null;     // { server, syncMaterials } once initialised
let initPromise = null;
function init() {
  if (!initPromise) {
    initPromise = (async () => {
      await loadConfig();
      const server = require('./server');
      await server.initOnce(); // seeds/bootstraps on a cold container, like ensureInit() in functions-index.js
      app = { server, syncMaterials: require('./materialsSync').syncMaterials };
    })().catch((err) => { initPromise = null; throw err; }); // let the next invocation retry
  }
  return initPromise;
}

/* ---------------- HTTP ---------------- */

// A Lambda Function URL cannot return more than ~6 MB. Big text responses (the 27K-row leads CSV export, large
// JSON lists) are gzip-compressed when the browser accepts it, which shrinks them roughly 8x.
const GZIP_MIN_CHARS = 100000;
function maybeGzip(event, result) {
  const headers = (event && event.headers) || {};
  const accepts = Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'accept-encoding' && /\bgzip\b/i.test(String(v)));
  if (!accepts || !result || result.isBase64Encoded || typeof result.body !== 'string' || result.body.length < GZIP_MIN_CHARS) return result;
  const out = { ...result, headers: { ...(result.headers || {}) } };
  if (Object.keys(out.headers).some((k) => k.toLowerCase() === 'content-encoding')) return result;
  const gz = require('zlib').gzipSync(Buffer.from(result.body, 'utf8'));
  for (const k of Object.keys(out.headers)) if (k.toLowerCase() === 'content-length') delete out.headers[k];
  out.headers['content-encoding'] = 'gzip';
  out.headers.vary = 'Accept-Encoding';
  out.body = gz.toString('base64');
  out.isBase64Encoded = true;
  if (gz.length > 5.5 * 1048576) console.warn(`Response is ${(gz.length / 1048576).toFixed(1)} MB even compressed - close to Lambda's 6 MB limit.`);
  return out;
}

const BINARY_TYPES = /spreadsheetml|octet-stream|pdf|zip|image\//i;
let httpHandler = null;
function getHttpHandler() {
  if (httpHandler) return httpHandler;
  const serverless = require('serverless-http');
  // Cloud Functions handed handleRequest a pre-buffered req.rawBody (server.js's readJsonBody prefers it and
  // has no 1 MB cap that way). Do the same here so large JSON uploads (scraper ingest) behave identically.
  const forward = (req, res) => {
    const chunks = [];
    // serverless-http 4 emits 'end' itself for body-less requests AND again once the stream is read, which ran
    // every GET (and any body-less POST/DELETE) through handleRequest twice. Handle each request exactly once.
    let handled = false;
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      if (handled) return;
      handled = true;
      req.rawBody = Buffer.concat(chunks);
      Promise.resolve(app.server.handleRequest(req, res)).catch((err) => {
        console.error('Unhandled request error:', err);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Internal server error' })); }
      });
    });
    req.on('error', (err) => { console.error('Request stream error:', err); });
  };
  httpHandler = serverless(forward, { binary: (headers) => BINARY_TYPES.test(String(headers['content-type'] || '')) });
  return httpHandler;
}

/* ---------------- Scheduled jobs ---------------- */

async function runJob(job, label) {
  const { server, syncMaterials } = app;
  if (job === 'pollSweep') {
    await server.pollSweep().catch((err) => console.error('Scheduled poll sweep failed:', err));
    // Tasking refresh (docs/TASKING.md): budget-capped and error-swallowing, so it cannot hurt the sweep.
    await server.runTaskingRefresh().catch((err) => console.error('Scheduled Tasking refresh failed:', err));
  } else if (job === 'materials') {
    const r = await syncMaterials().catch((err) => { console.error(`Materials sync (${label}) failed:`, err); return null; });
    if (r) {
      console.log(`Materials sync (${label}): ${r.filesProcessed} file(s), ${r.skipped.length} skipped, ${r.errors.length} error(s).`);
      r.errors.forEach((e) => console.error('Materials sync error:', e));
    }
  } else if (job === 'smartInsights') {
    const r = await server.syncSmartInsights().catch((err) => { console.error('Scheduled Smart Insights sync failed:', err); return null; });
    if (r) {
      console.log(`Smart Insights sync: ${r.filesProcessed} report(s) processed, ${r.jobsCreated} job(s) created, ${r.jobsUpdated} updated, ${r.rowsSkipped} row(s) skipped, ${r.errors.length} error(s).`);
      r.errors.forEach((e) => console.error('Smart Insights sync error:', e));
    }
  } else if (job === 'calendar') {
    const r = await server.pollGoogleCalendarFeed().catch((err) => { console.error(`Scheduled calendar sweep (${label}) failed:`, err); return null; });
    if (r) {
      console.log(`Calendar sweep (${label}): ${r.matchedCount} matched (${r.mergedCount} merged), ${r.skippedNoMatch} skipped, ${r.autoAssignedTruckCount} truck(s)/${r.autoAssignedDriverCount} driver(s) auto-assigned, ${r.errors.length} error(s).`);
      r.errors.forEach((e) => console.error(`Calendar sweep (${label}) error:`, e));
    }
  } else {
    throw new Error(`Unknown scheduled job: ${job}`);
  }
}

exports.handler = async (event, context) => {
  await init();
  if (event && typeof event.job === 'string') {
    await runJob(event.job, event.label || event.job);
    return { ok: true, job: event.job };
  }
  return maybeGzip(event, await getHttpHandler()(event, context));
};
exports._runJob = runJob; // for tests
