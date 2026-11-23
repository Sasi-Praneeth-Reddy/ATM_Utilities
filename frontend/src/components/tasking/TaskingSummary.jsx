import { useCallback, useEffect, useState } from 'react';
import { fetchSummary, refreshFromSmartMoving, saveJobState, saveDayState } from './taskingApi';
import { todayLocalIso, shiftIso, fmtDate, fmtTime, fmtMoney } from './taskingUtils';
import NotSecuredList from './NotSecuredList';

/** One titled list on the Summary page. */
function Card({ title, count, hint, children }) {
  return (
    <section className="tk-card">
      <div className="tk-card-head">
        <h3>{title}</h3>
        <span className="tk-count">{count}</span>
      </div>
      {hint && <p className="tk-hint">{hint}</p>}
      {children}
    </section>
  );
}

const Empty = ({ text }) => <div className="tk-empty">{text}</div>;

export default function TaskingSummary({ backendUrl }) {
  const [date, setDate] = useState(todayLocalIso());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await fetchSummary(backendUrl, date));
    } catch (err) {
      setError(err.message);
    }
  }, [backendUrl, date]);

  useEffect(() => { setData(null); load(); }, [load]);

  /** Applies a per-job change on screen immediately (so ticks feel instant), then saves it; reloads if the save fails. */
  async function saveJob(jobId, patch, applyLocal) {
    setData((d) => (d ? applyLocal(d) : d));
    try {
      await saveJobState(backendUrl, jobId, patch);
    } catch (err) {
      window.alert(`Couldn't save: ${err.message}`);
      load();
    }
  }

  async function setCallOwner(owner) {
    // Instant: change the day owner and every row that has no assignee of its own, then save in the background.
    setData((d) => (d ? { ...d, callOwner: owner, calls: d.calls.map((c) => (c.ownAssignee ? c : { ...c, assignee: owner })) } : d));
    try { await saveDayState(backendUrl, date, { callOwner: owner }); }
    catch (err) { window.alert(`Couldn't save: ${err.message}`); load(); }
  }

  async function refresh() {
    setBusy(true); setRefreshMsg('');
    try {
      const r = await refreshFromSmartMoving(backendUrl);
      const f = r.finance || {}; const c = r.claims || {}; const jb = r.jobs || {};
      setRefreshMsg(`Updated ${f.refreshed ?? 0} opportunities, checked ${c.customersChecked ?? 0} customers for claims and imported job notes for ${jb.imported ?? 0} jobs.`
        + (f.stoppedForBudget || c.stoppedForBudget ? ' Stopped early to protect the daily SmartMoving API budget.' : '')
        + (f.failed || c.failed || jb.failed ? ` ${(f.failed || 0) + (c.failed || 0) + (jb.failed || 0)} lookups failed.` : ''));
      await load();
    } catch (err) { setRefreshMsg(`Refresh failed: ${err.message}`); } finally { setBusy(false); }
  }

  const meta = data && data.meta;
  const calls = data ? data.calls : [];
  const callsLeft = calls.filter((c) => !c.callDone).length;

  return (
    <div className="tk">
      <div className="toolbar">
        <h2 className="section-title">Tasking — pending actions</h2>
        <div className="datepick">
          <button className="btn secondary" onClick={() => setDate(shiftIso(date, -1))}>←</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn secondary" onClick={() => setDate(shiftIso(date, 1))}>→</button>
          <button className="btn secondary" onClick={() => setDate(todayLocalIso())}>Today</button>
          <button className="btn" onClick={refresh} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh from SmartMoving'}</button>
        </div>
      </div>
      {refreshMsg && <div className="tk-msg">{refreshMsg}</div>}
      {meta && (
        <div className="tk-fresh">
          Payment and claim data last refreshed {meta.refreshedAt ? new Date(meta.refreshedAt).toLocaleString() : 'never'} (also refreshes itself every morning).
        </div>
      )}
      {error && <div className="sync-msg err">{error}</div>}
      {!data && !error && <div className="tk-empty">Loading…</div>}

      {data && (
        <div className="tk-grid">
          <Card title={`Call list — ${fmtDate(date)}`} count={`${callsLeft} to call`}
            hint={`Every customer job on this day by arrival time. Tick it once the customer has been called.${data.callsMilitaryHidden ? ` ${data.callsMilitaryHidden} military job(s) not shown (see the Military section).` : ''}`}>
            <div className="tk-owner">
              Who calls today:
              {['crew', 'erika'].map((o) => (
                <button key={o} className={`btn secondary${data.callOwner === o ? ' active' : ''}`} onClick={() => setCallOwner(o)}>{o === 'crew' ? 'Crew' : 'Erika'}</button>
              ))}
            </div>
            {!calls.length ? <Empty text="No jobs on this day." /> : (
              <table className="tk-table">
                <thead><tr><th /><th>Time</th><th>Customer</th><th>Phone</th><th>Calls</th><th /></tr></thead>
                <tbody>
                  {calls.map((c) => (
                    <tr key={c.jobId} className={c.callDone ? 'tk-done' : ''}>
                      <td><input type="checkbox" checked={c.callDone} title={c.callDone && c.callDoneBy ? `Called by ${c.callDoneBy}` : 'Mark called'}
                        onChange={(e) => saveJob(c.jobId, { callDone: e.target.checked }, (d) => ({ ...d, calls: d.calls.map((x) => (x.jobId === c.jobId ? { ...x, callDone: e.target.checked } : x)) }))} /></td>
                      <td>{fmtTime(c.time)}</td>
                      <td><b>{c.customer}</b><div className="tk-sub">{c.origin}{c.destination ? ` → ${c.destination}` : ''}</div></td>
                      <td>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : <span className="tk-sub">—</span>}</td>
                      <td>
                        <select value={c.assignee} onChange={(e) => saveJob(c.jobId, { callAssignee: e.target.value }, (d) => ({ ...d, calls: d.calls.map((x) => (x.jobId === c.jobId ? { ...x, assignee: e.target.value, ownAssignee: true } : x)) }))}>
                          <option value="crew">Crew</option><option value="erika">Erika</option>
                        </select>
                      </td>
                      <td>{c.pbo && <span className="tk-pill tk-amber">PBO</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="PBO — upsell follow-ups" count={data.pbo.length}
            hint={`Jobs from ${fmtDate(date)} to ${fmtDate(shiftIso(date, 14))} flagged packed-by-owner (found in SmartMoving text, or set here). Follow up to offer packing.`}>
            {!data.pbo.length ? <Empty text="No PBO jobs in the 14 days from this day." /> : (
              <table className="tk-table">
                <thead><tr><th>Job</th><th>Status</th><th>Note</th><th>Follow up by</th></tr></thead>
                <tbody>
                  {data.pbo.map((p) => (
                    <tr key={p.jobId} className={p.upsellStatus !== 'open' ? 'tk-done' : ''}>
                      <td><b>{p.customer}</b><div className="tk-sub">{fmtDate(p.date)} · {p.daysLeft === 0 ? 'on this day' : `${p.daysLeft}d after this day`}{p.source === 'manual' ? ' · set manually' : ''}</div></td>
                      <td>
                        <select value={p.upsellStatus} onChange={(e) => saveJob(p.jobId, { upsellStatus: e.target.value }, (d) => ({ ...d, pbo: d.pbo.map((x) => (x.jobId === p.jobId ? { ...x, upsellStatus: e.target.value } : x)) }))}>
                          <option value="open">To do</option><option value="done">Upsold</option><option value="declined">Declined</option>
                        </select>
                      </td>
                      <td><input type="text" defaultValue={p.upsellNote} placeholder="Add a note…" maxLength={500}
                        onBlur={(e) => e.target.value !== p.upsellNote && saveJob(p.jobId, { upsellNote: e.target.value }, (d) => ({ ...d, pbo: d.pbo.map((x) => (x.jobId === p.jobId ? { ...x, upsellNote: e.target.value } : x)) }))} /></td>
                      <td><input type="date" defaultValue={p.upsellDue || ''}
                        onBlur={(e) => (e.target.value || null) !== p.upsellDue && saveJob(p.jobId, { upsellDue: e.target.value || null }, (d) => ({ ...d, pbo: d.pbo.map((x) => (x.jobId === p.jobId ? { ...x, upsellDue: e.target.value || null } : x)) }))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Upcoming jobs not secured" count={data.notSecured.length}
            hint="Up to 60 days ahead. Estimate not signed, or booked with no deposit paid. Soonest first.">
            {!data.notSecured.length ? <Empty text="Nothing waiting on a signature or deposit." /> : (
              <NotSecuredList rows={data.notSecured} />
            )}
          </Card>

          <Card title="Completed jobs not paid" count={data.unpaidCompleted.length}
            hint="Completed in the last 120 days with a balance still outstanding. Oldest first.">
            {!data.unpaidCompleted.length ? <Empty text="No unpaid completed jobs." /> : (
              <table className="tk-table">
                <thead><tr><th>Customer</th><th>Job date</th><th>Since</th><th>Balance due</th></tr></thead>
                <tbody>
                  {data.unpaidCompleted.map((u) => (
                    <tr key={u.oppId}>
                      <td><b>{u.customer}</b>{u.quote ? <span className="tk-sub"> #{u.quote}</span> : null}{u.phone && <div className="tk-sub"><a href={`tel:${u.phone}`}>{u.phone}</a></div>}</td>
                      <td>{fmtDate(u.serviceDate)}</td>
                      <td>{u.daysSince}d</td>
                      <td><b>{fmtMoney(u.balanceDue)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Active claims" count={data.claims.length} hint="SmartMoving service tickets of type Claim that aren't completed.">
            {!data.claims.length ? <Empty text="No active claims." /> : (
              <table className="tk-table">
                <thead><tr><th>Customer</th><th>Ticket</th><th>Status</th><th>Opened</th></tr></thead>
                <tbody>
                  {data.claims.map((c) => (
                    <tr key={c.id}>
                      <td><b>{c.customer}</b></td><td>{c.name}</td>
                      <td>{c.status === 'InProgress' ? 'In progress' : 'Not started'}</td>
                      <td>{c.createdAt ? fmtDate(c.createdAt.slice(0, 10)) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
