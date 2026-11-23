import { useCallback, useEffect, useState } from 'react';
import { fetchDispatch, saveJobState, sendAssignments, importDispatchFromSmartMoving, checkMaterialsEmail, uploadMaterialsReport } from './taskingApi';
import { todayLocalIso, shiftIso, fmtDate, fmtTime } from './taskingUtils';

const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Opens a clean printable list of the day's materials (what Mark prints and ticks off). */
function printMaterials(date, jobs) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rows = jobs.map((j) => {
    const mats = j.materials;
    const crates = j.crates;
    if (!mats.length && !crates.length) return '';
    return `<h3>${esc(fmtTime(j.time))} — ${esc(j.customer)}</h3><ul>`
      + mats.map((m) => (m.done ? `<li><b>☑ ${esc(m.qty)} × ${esc(m.name)}</b></li>` : `<li>☐ ${esc(m.qty)} × ${esc(m.name)}</li>`)).join('')
      + crates.map((c) => `<li>☐ ${esc(c.qty)} × ${esc(c.label || 'Crate')} (crate)</li>`).join('') + '</ul>';
  }).join('');
  const w = window.open('', '_blank');
  if (!w) { window.alert('Allow pop-ups to print the materials list.'); return; }
  w.document.write(`<!doctype html><title>Materials ${esc(date)}</title><body style="font-family:Arial,sans-serif;padding:24px"><h2>Materials — ${esc(fmtDate(date))}</h2>${rows || '<p>No materials entered for this day.</p>'}</body>`);
  w.document.close(); w.focus(); w.print();
}

/** SmartMoving note types, in the order they are shown on a job card. `cls` picks the tag colour. */
const NOTE_TYPES = [
  { key: 'internal', label: 'Internal', cls: 'tk-nt-internal' },
  { key: 'customer', label: 'Customer', cls: 'tk-nt-customer' },
  { key: 'crew', label: 'Crew notes', cls: 'tk-nt-crew' },
  { key: 'crewFeedback', label: 'Crew feedback', cls: 'tk-nt-feedback' },
  { key: 'dispatch', label: 'Dispatcher notes', cls: 'tk-nt-dispatch' },
];

/** Turns job.smNoteSections into rows to draw. SmartMoving often copies the same text under two headings
 *  (usually Crew and Customer); those are shown once, with both tags, instead of twice. */
function noteGroups(sections) {
  const groups = [];
  for (const type of NOTE_TYPES) {
    const text = ((sections && sections[type.key]) || '').trim();
    if (!text) continue;
    const same = groups.find((g) => g.text === text);
    if (same) same.types.push(type); else groups.push({ text, types: [type] });
  }
  return groups;
}

function JobCard({ job, onSave }) {
  const [matName, setMatName] = useState('');
  const [matQty, setMatQty] = useState('1');
  const [crateLabel, setCrateLabel] = useState('');
  const [crateQty, setCrateQty] = useState('1');
  const [note, setNote] = useState(job.dispatchNote);
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => { setNote(job.dispatchNote); }, [job.dispatchNote]);

  const mats = job.materials; // completed items stay visible (shown in bold)
  const groups = noteGroups(job.smNoteSections); // empty for jobs imported before notes were split by type
  const longNotes = (job.smNotes || '').length + job.smStopNotes.reduce((n, x) => n + (x.notes || '').length, 0) > 320;

  const saveMats = (list) => onSave(job.jobId, { materials: list });
  const saveCrates = (list) => onSave(job.jobId, { crates: list });

  return (
    <div className="tk-card tk-job">
      <div className="tk-card-head">
        <h3>{fmtTime(job.time)} — {job.customer}</h3>
        <span className="tk-sub">
          {job.trucks.length ? job.trucks.map((t) => `${t.name}${t.driver ? ` (${t.driver})` : ''}`).join(', ') : <b className="tk-red-text">No truck assigned</b>}
          {job.emailedAt ? ` · emailed ${new Date(job.emailedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
      </div>
      <div className="tk-sub">{job.origin}{job.destination ? ` → ${job.destination}` : ''}{job.crewSize ? ` · crew of ${job.crewSize}` : ''}</div>

      {(job.smNotes || job.smStopNotes.length > 0) && (
        <div className={`tk-sm${longNotes && !notesOpen ? ' tk-clamp' : ''}`}>
          <div className="tk-label" style={{ marginTop: 0 }}>From SmartMoving</div>
          {groups.length > 0 ? groups.map((g) => (
            <div key={g.types[0].key} className="tk-note">
              <div className="tk-note-tags">{g.types.map((t) => <span key={t.key} className={`tk-note-tag ${t.cls}`}>{t.label}</span>)}</div>
              <div className="tk-note-text">{g.text}</div>
            </div>
          )) : (job.smNotes && <div>{job.smNotes}</div>)}
          {job.smStopNotes.map((s, i) => <div key={i}><b>{s.address || 'Stop'}:</b> {s.notes}</div>)}
          {longNotes && <button type="button" className="tk-more" onClick={() => setNotesOpen(!notesOpen)}>{notesOpen ? 'Show less' : 'Show more'}</button>}
        </div>
      )}

      <label className="tk-label">Dispatch notes (office)</label>
      <textarea rows={2} maxLength={2000} value={note} placeholder="Gate codes, parking, special items…"
        onChange={(e) => setNote(e.target.value)} onBlur={() => note !== job.dispatchNote && onSave(job.jobId, { dispatchNote: note })} />

      <div className="tk-cols">
        <div>
          <label className="tk-label">Materials</label>
          {mats.map((m) => (
            <div className={`tk-line${m.done ? ' tk-ticked' : ''}`} key={m.id}>
              <input type="checkbox" checked={m.done} title={m.done && m.doneBy ? `Done by ${m.doneBy}` : 'Mark done'}
                onChange={(e) => saveMats(job.materials.map((x) => (x.id === m.id ? { ...x, done: e.target.checked } : x)))} />
              <span>{m.qty} × {m.name}</span>
              {m.source === 'sm' ? <span className="tk-tag" title="Imported from SmartMoving">SM</span>
                : <button className="tk-x" title="Remove" onClick={() => saveMats(job.materials.filter((x) => x.id !== m.id))}>×</button>}
            </div>
          ))}
          <form className="tk-add" onSubmit={(e) => { e.preventDefault(); if (!matName.trim()) return; saveMats([...job.materials, { id: newId('m'), name: matName.trim(), qty: Number(matQty) || 1, done: false }]); setMatName(''); setMatQty('1'); }}>
            <input type="number" min="0" value={matQty} onChange={(e) => setMatQty(e.target.value)} style={{ width: 56 }} />
            <input type="text" value={matName} onChange={(e) => setMatName(e.target.value)} placeholder="e.g. Medium boxes" maxLength={80} />
            <button className="btn secondary" type="submit">Add</button>
          </form>
        </div>
        <div>
          <label className="tk-label">Crates</label>
          {job.crates.map((c) => (
            <div className="tk-line" key={c.id}>
              <span>{c.qty} × {c.label || 'Crate'}</span>
              {c.source === 'sm' ? <span className="tk-tag" title="Imported from SmartMoving">SM</span>
                : <button className="tk-x" title="Remove" onClick={() => saveCrates(job.crates.filter((x) => x.id !== c.id))}>×</button>}
            </div>
          ))}
          <form className="tk-add" onSubmit={(e) => { e.preventDefault(); saveCrates([...job.crates, { id: newId('c'), label: crateLabel.trim() || 'Crate', qty: Number(crateQty) || 1 }]); setCrateLabel(''); setCrateQty('1'); }}>
            <input type="number" min="0" value={crateQty} onChange={(e) => setCrateQty(e.target.value)} style={{ width: 56 }} />
            <input type="text" value={crateLabel} onChange={(e) => setCrateLabel(e.target.value)} placeholder="Crate type (optional)" maxLength={80} />
            <button className="btn secondary" type="submit">Add</button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function TaskingDispatch({ backendUrl, userEmail }) {
  const [date, setDate] = useState(todayLocalIso());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [to, setTo] = useState(userEmail || '');
  const [sendMsg, setSendMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [matBusy, setMatBusy] = useState(false);

  const load = useCallback(async () => {
    try { setError(''); setData(await fetchDispatch(backendUrl, date)); } catch (err) { setError(err.message); }
  }, [backendUrl, date]);
  useEffect(() => { setData(null); load(); }, [load]);

  async function save(jobId, patch) {
    // Apply instantly, then confirm with the server's copy; reload on failure.
    setData((d) => ({ ...d, jobs: d.jobs.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)) }));
    try { await saveJobState(backendUrl, jobId, patch); } catch (err) { window.alert(`Couldn't save: ${err.message}`); load(); }
  }

  async function importFromSm() {
    setImporting(true); setSendMsg('');
    try {
      const r = await importDispatchFromSmartMoving(backendUrl, date);
      const c = r.calendarRun || {};
      setSendMsg(c.error ? `Calendar read failed: ${c.error}`
        : `Calendar read: ${c.received ?? 0} events, ${c.inWindow ?? 0} upcoming, ${c.withNotes ?? 0} with notes, ${c.updated ?? 0} newly saved.`
          + (r.calendar && r.calendar.errors && r.calendar.errors.length ? ` Sync errors: ${r.calendar.errors.map(e => e.message || e).join('; ')}` : ''));
      await load();
    } catch (err) { setSendMsg(`Import failed: ${err.message}`); } finally { setImporting(false); }
  }

  const matSummary = (r) => `${r.updated ?? 0} job(s) updated${r.cleared ? `, ${r.cleared} cleared` : ''} (${r.boardJobsInWindow ?? 0} board jobs in the next 4 weeks, ${r.reportJobsInWindow ?? 0} in the report)`
    + (r.unmatchedCount ? `. ${r.unmatchedCount} report job(s) not on the board, e.g. ${(r.unmatched || []).slice(0, 5).join(', ')}` : '');

  async function checkMaterials() {
    setMatBusy(true); setSendMsg('');
    try {
      const r = await checkMaterialsEmail(backendUrl);
      setSendMsg(r.imports && r.imports.length ? `Materials report imported: ${r.imports.map(matSummary).join(' | ')}`
        : `No new materials report email found.${r.skipped && r.skipped.length ? ` Skipped: ${r.skipped.slice(0, 2).join('; ')}` : ''}${r.errors && r.errors.length ? ` Errors: ${r.errors.join('; ')}` : ''}`);
      await load();
    } catch (err) { setSendMsg(`Check failed: ${err.message}`); } finally { setMatBusy(false); }
  }

  async function uploadMaterials(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    setMatBusy(true); setSendMsg('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      setSendMsg(`Materials report imported: ${matSummary(await uploadMaterialsReport(backendUrl, file.name, btoa(bin)))}`);
      await load();
    } catch (err) { setSendMsg(`Upload failed: ${err.message}`); } finally { setMatBusy(false); }
  }

  async function send() {
    const list = to.split(/[,\s;]+/).filter(Boolean);
    setSending(true); setSendMsg('');
    try {
      const r = await sendAssignments(backendUrl, date, list);
      setSendMsg(`Sent ${r.jobCount} jobs to ${r.sentTo.join(', ')}.`);
      load();
    } catch (err) { setSendMsg(err.message); } finally { setSending(false); }
  }

  return (
    <div className="tk">
      <div className="toolbar">
        <h2 className="section-title">Dispatch — notes, materials and crates</h2>
        <div className="datepick">
          <button className="btn secondary" onClick={() => setDate(shiftIso(date, -1))}>←</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn secondary" onClick={() => setDate(shiftIso(date, 1))}>→</button>
          <button className="btn secondary" onClick={() => setDate(todayLocalIso())}>Today</button>
        </div>
      </div>

      <div className="tk-bar">
        <button className="btn secondary" disabled={importing || !data || !data.jobs.length} onClick={importFromSm}>{importing ? 'Importing…' : 'Import notes from SmartMoving'}</button>
        <button className="btn secondary" disabled={matBusy} onClick={checkMaterials}>{matBusy ? 'Working…' : 'Check materials email'}</button>
        <label className="btn secondary" style={{ cursor: 'pointer' }}>Upload materials report<input type="file" accept=".xlsx" hidden disabled={matBusy} onChange={uploadMaterials} /></label>
        <button className="btn secondary" disabled={!data || !data.jobs.length} onClick={() => printMaterials(date, data.jobs)}>Print materials</button>
        <span className="tk-send">
          <input type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Email to (comma separated)" />
          <button className="btn" onClick={send} disabled={sending || !data || !data.jobs.length}>{sending ? 'Sending…' : 'Email assigned jobs'}</button>
        </span>
      </div>
      {data && data.materialsImport && <div className="tk-fresh">Materials last imported {new Date(data.materialsImport.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — {data.materialsImport.updated} job(s) updated. The report is checked at 6:30 AM and 5:00 PM.</div>}
      {sendMsg && <div className="tk-msg">{sendMsg}</div>}
      {error && <div className="sync-msg err">{error}</div>}
      {!data && !error && <div className="tk-empty">Loading…</div>}
      {data && !data.jobs.length && <div className="tk-empty">No jobs on {fmtDate(date)}.</div>}
      {data && data.jobs.length > 0 && <div className="tk-jobs">{data.jobs.map((j) => <JobCard key={j.jobId} job={j} onSave={save} />)}</div>}
    </div>
  );
}
