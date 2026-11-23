/** node test-lambda.js - checks lambda.js (Function URL events in, scheduled jobs, binary, cookies, big bodies) with server.js stubbed. */
const assert = require('assert');
const Module = require('module');
process.env.ATM_SKIP_SSM = '1';

const calls = [];
const stubServer = {
  initOnce: async () => { calls.push('init'); },
  pollSweep: async () => { calls.push('pollSweep'); },
  runTaskingRefresh: async () => { calls.push('tasking'); },
  syncSmartInsights: async () => { calls.push('smartInsights'); return { filesProcessed: 1, jobsCreated: 0, jobsUpdated: 0, rowsSkipped: 0, errors: [] }; },
  pollGoogleCalendarFeed: async () => { calls.push('calendar'); return { matchedCount: 1, mergedCount: 0, skippedNoMatch: 0, autoAssignedTruckCount: 0, autoAssignedDriverCount: 0, errors: [] }; },
  handleRequest: async (req, res) => {
    stubServer.requests = (stubServer.requests || 0) + 1;
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': req.headers.origin || '*' }); return res.end(); }
    if (url.pathname === '/echo') {
      assert.ok(Buffer.isBuffer(req.rawBody), 'rawBody is a Buffer');
      const body = req.rawBody.length ? JSON.parse(req.rawBody.toString('utf8')) : null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['a=1; HttpOnly', 'b=2; HttpOnly'] });
      return res.end(JSON.stringify({ method: req.method, path: url.pathname, q: url.search, auth: req.headers.authorization || null, cookie: req.headers.cookie || null, len: JSON.stringify(body || {}).length }));
    }
    if (url.pathname === '/bin') { res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); return res.end(Buffer.from([0, 255, 1, 254, 80, 75])); }
    if (url.pathname === '/csv') { res.writeHead(200, { 'Content-Type': 'text/csv', 'X-Row-Count': '3' }); return res.end('a,b\n1,2\n'); }
    if (url.pathname === '/bigtext') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); return res.end('row,of,data,1234567890\n'.repeat(60000)); }
    if (url.pathname === '/boom') throw new Error('boom');
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}');
  },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './server') return stubServer;
  if (req === './materialsSync') return { syncMaterials: async () => { calls.push('materials'); return { filesProcessed: 0, skipped: [], errors: [] }; } };
  return origLoad.apply(this, arguments);
};
const { handler } = require('./lambda');

const ev = (over = {}) => ({
  version: '2.0', rawPath: '/echo', rawQueryString: '', headers: { origin: 'https://atm-scheduler.web.app', 'content-type': 'application/json' },
  requestContext: { http: { method: 'GET', path: over.rawPath || '/echo' }, requestId: 'r1' }, isBase64Encoded: false, ...over,
});

(async () => {
  let r = await handler(ev({ rawQueryString: 'x=1', requestContext: { http: { method: 'GET', path: '/echo' } } }), {});
  assert.equal(r.statusCode, 200); let b = JSON.parse(r.body); assert.equal(b.q, '?x=1'); assert.equal(b.len, 2);
  assert.deepEqual(r.cookies || [], ['a=1; HttpOnly', 'b=2; HttpOnly']); console.log('ok GET + multiple Set-Cookie + query string');

  stubServer.requests = 0;
  await handler(ev({ rawPath: '/csv', requestContext: { http: { method: 'GET', path: '/csv' } } }), {});
  await handler(ev({ rawPath: '/echo', requestContext: { http: { method: 'DELETE', path: '/echo' } } }), {});
  assert.equal(stubServer.requests, 2, 'each body-less request must reach handleRequest exactly once'); console.log('ok body-less requests are handled once, not twice');

  const big = JSON.stringify({ rows: 'x'.repeat(3 * 1024 * 1024) });
  r = await handler(ev({ body: big, headers: { 'content-type': 'application/json' }, requestContext: { http: { method: 'POST', path: '/echo' } } }), {});
  assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.body).len, big.length); console.log('ok 3 MB JSON body arrives in req.rawBody (no 1 MB cap)');

  r = await handler(ev({ headers: { authorization: 'Bearer tok123', cookie: 'z=9', origin: 'https://x' } }), {});
  b = JSON.parse(r.body); assert.equal(b.auth, 'Bearer tok123'); assert.ok(b.cookie.includes('z=9')); console.log('ok Authorization + Cookie headers reach the handler');

  r = await handler(ev({ rawPath: '/bin', requestContext: { http: { method: 'GET', path: '/bin' } } }), {});
  assert.equal(r.isBase64Encoded, true); assert.deepEqual([...Buffer.from(r.body, 'base64')], [0, 255, 1, 254, 80, 75]); console.log('ok binary responses are base64');

  r = await handler(ev({ rawPath: '/csv', requestContext: { http: { method: 'GET', path: '/csv' } } }), {});
  assert.equal(r.isBase64Encoded, false); assert.equal(r.body, 'a,b\n1,2\n'); assert.equal(r.headers['x-row-count'], '3'); console.log('ok CSV stays text with its headers');

  r = await handler(ev({ requestContext: { http: { method: 'OPTIONS', path: '/echo' } } }), {});
  assert.equal(r.statusCode, 204); assert.equal(r.headers['access-control-allow-origin'], 'https://atm-scheduler.web.app'); console.log('ok CORS preflight');

  const bigEv = (h) => ev({ rawPath: '/bigtext', headers: h, requestContext: { http: { method: 'GET', path: '/bigtext' } } });
  r = await handler(bigEv({ 'accept-encoding': 'gzip, deflate, br' }), {});
  assert.equal(r.headers['content-encoding'], 'gzip'); assert.equal(r.isBase64Encoded, true);
  assert.equal(require('zlib').gunzipSync(Buffer.from(r.body, 'base64')).toString().length, 'row,of,data,1234567890\n'.length * 60000);
  assert.ok(r.body.length < 200000, 'compressed well under the 6 MB limit');
  r = await handler(bigEv({}), {}); assert.equal(r.headers['content-encoding'], undefined); assert.equal(r.isBase64Encoded, false);
  console.log('ok large text is gzipped only when the browser accepts gzip');

  r = await handler(ev({ rawPath: '/boom', requestContext: { http: { method: 'GET', path: '/boom' } } }), {});
  assert.equal(r.statusCode, 500); console.log('ok handler errors become a 500, not a crash');

  for (const job of ['pollSweep', 'materials', 'smartInsights', 'calendar']) await handler({ job, label: 'test' }, {});
  assert.deepEqual(calls.filter((c) => c !== 'init'), ['pollSweep', 'tasking', 'materials', 'smartInsights', 'calendar']);
  assert.equal(calls.filter((c) => c === 'init').length, 1, 'initOnce ran once for all invocations'); console.log('ok scheduled jobs run the right functions; init once per container');

  await assert.rejects(handler({ job: 'nope' }, {}), /Unknown scheduled job/); console.log('ok unknown job fails loudly');
  console.log('\nLambda entry point tests passed.'); process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
