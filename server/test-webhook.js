/**
 * Sends a sample webhook event to a running sync backend, so you can confirm the receiver works
 * without waiting for SmartMoving to actually fire one. Point it at your backend and an
 * opportunity id:
 *
 *   node test-webhook.js [backendUrl] [opportunityId] [eventType]
 *
 * Defaults to http://localhost:8787, opp-direct-004 (a job that only exists via the mock's
 * opportunity-details endpoint, not via /api/leads — proves the webhook path catches bookings the
 * poll sweep can't see), and event type job-created.
 */
const backendUrl = process.argv[2] || 'http://localhost:8787';
const opportunityId = process.argv[3] || 'opp-direct-004';
const eventType = process.argv[4] || 'job-created';
const secret = process.env.WEBHOOK_SECRET || '';

async function main() {
  const url = new URL('/webhooks/smartmoving', backendUrl);
  if (secret) url.searchParams.set('secret', secret);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'event-type': eventType, 'opportunity-id': opportunityId, 'opportunity-status': 4 }),
  });
  console.log('Webhook POST status:', res.status);
  console.log(await res.text());
}

main().catch(err => { console.error(err); process.exit(1); });
