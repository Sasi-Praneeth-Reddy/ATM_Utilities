/**
 * Starts / reports on the storage-price scraper, which runs as a GitHub Actions workflow
 * (repo Storage-Tracker-Server, workflow daily-scraper.yml, input target=storage).
 *
 * Needs a GitHub fine-grained token with "Actions: Read and write" on that one repo, kept in the
 * GITHUB_DISPATCH_TOKEN secret. Optional env: GITHUB_SCRAPER_REPO, GITHUB_SCRAPER_WORKFLOW, GITHUB_SCRAPER_REF.
 */
const REPO = () => process.env.GITHUB_SCRAPER_REPO || 'Sasi-Praneeth-Reddy/Storage-Tracker-Server';
const WORKFLOW = () => process.env.GITHUB_SCRAPER_WORKFLOW || 'daily-scraper.yml';
const REF = () => process.env.GITHUB_SCRAPER_REF || 'main';

function headers() {
  const token = (process.env.GITHUB_DISPATCH_TOKEN || '').trim();
  if (!token) {
    const e = new Error('The scraper trigger is not set up yet (GITHUB_DISPATCH_TOKEN secret is missing).');
    e.status = 501;
    throw e;
  }
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'atm-scheduler' };
}

async function latestRun() {
  const r = await fetch(`https://api.github.com/repos/${REPO()}/actions/workflows/${WORKFLOW()}/runs?per_page=5&event=workflow_dispatch`, { headers: headers() });
  if (!r.ok) { const e = new Error(`GitHub returned ${r.status} while reading scraper runs`); e.status = 502; throw e; }
  const data = await r.json();
  const run = (data.workflow_runs || [])[0];
  return run ? { id: run.id, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, updatedAt: run.updated_at, url: run.html_url } : null;
}

async function startStorageScrape() {
  const current = await latestRun();
  if (current && current.status !== 'completed') {
    const e = new Error('A scraper run is already in progress.');
    e.status = 409;
    throw e;
  }
  const r = await fetch(`https://api.github.com/repos/${REPO()}/actions/workflows/${WORKFLOW()}/dispatches`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: REF(), inputs: { target: 'storage' } }),
  });
  if (r.status !== 204) {
    const text = (await r.text()).slice(0, 200);
    const e = new Error(`GitHub refused to start the scraper (${r.status}): ${text}`);
    e.status = 502;
    throw e;
  }
  return { started: true };
}

module.exports = { startStorageScrape, latestRun };
