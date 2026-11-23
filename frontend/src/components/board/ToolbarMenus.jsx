import { useEffect, useRef, useState } from 'react';

/** Small dropdown used by the board toolbar. Closes on outside click or Escape. */
function Menu({ label, title, badge, children, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="tb-menu" ref={ref}>
      <button type="button" className={`btn secondary tb-menu-btn ${open ? 'active-soft' : ''}`} onClick={() => setOpen((v) => !v)} title={title} aria-haspopup="true" aria-expanded={open}>
        {label}{badge > 0 && <span className="oa-count-badge">{badge}</span>}<span className="tb-caret" aria-hidden="true">▾</span>
      </button>
      {open && <div className={`tb-pop ${align === 'right' ? 'right' : ''}`} role="dialog">{typeof children === 'function' ? children(() => setOpen(false)) : children}</div>}
    </div>
  );
}

/** "View" menu: the two display switches that used to sit loose in the toolbar. */
export function ViewMenu({ hideInTransit, setHideInTransit, transitHiddenCount, showGridView, setShowGridView, isPhone }) {
  return (
    <Menu label="View" title="Board display options" badge={hideInTransit ? transitHiddenCount : 0}>
      {isPhone ? (
        <label className="tb-row">
          <input type="checkbox" checked={!showGridView} onChange={(e) => setShowGridView(!e.target.checked)} />
          <span><b>Timeline view</b><small>Hour-by-hour bars where you can drag jobs. Off = compact grid.</small></span>
        </label>
      ) : (
        <label className="tb-row">
          <input type="checkbox" checked={showGridView} onChange={(e) => setShowGridView(e.target.checked)} />
          <span><b>Compact grid</b><small>One dense, read-only row per truck.</small></span>
        </label>
      )}
      <label className="tb-row">
        <input type="checkbox" checked={hideInTransit} onChange={(e) => setHideInTransit(e.target.checked)} />
        <span><b>Hide in-transit days</b><small>Long-distance jobs on days they are only travelling.</small></span>
      </label>
    </Menu>
  );
}

const WHAT = [
  ['list', 'Day list', 'A plain text list of the day’s jobs.'],
  ['board', 'Truck board', 'Trucks working today, with Unassigned Jobs below.'],
  ['all', 'All trucks', 'Every truck in the fleet, including empty ones.'],
];
const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* optional */ } };

/** One "Print" menu: what to print, page orientation, in-transit option, one Print button. */
export function PrintMenu({ includeTransitPrint, setIncludeTransitPrint, onPrint }) {
  const [what, setWhat] = useState(() => read('atm.print.what', 'board'));
  const [orientation, setOrientation] = useState(() => read('atm.print.orientation', 'landscape'));
  const pick = (setter, key) => (v) => { setter(v); write(key, v); };
  return (
    <Menu label="🖨 Print" title="Print the day" align="right">
      {(close) => (
        <>
          <div className="tb-group-label">What to print</div>
          {WHAT.map(([id, name, hint]) => (
            <label key={id} className={`tb-row radio ${what === id ? 'on' : ''}`}>
              <input type="radio" name="print-what" checked={what === id} onChange={() => pick(setWhat, 'atm.print.what')(id)} />
              <span><b>{name}</b><small>{hint}</small></span>
            </label>
          ))}
          <div className="tb-group-label">Page</div>
          <div className="tb-seg" role="radiogroup" aria-label="Page orientation">
            {[['portrait', 'Portrait'], ['landscape', 'Landscape']].map(([id, name]) => (
              <button key={id} type="button" role="radio" aria-checked={orientation === id} className={`tb-seg-btn ${orientation === id ? 'on' : ''}`} onClick={() => pick(setOrientation, 'atm.print.orientation')(id)}>
                <span className={`tb-page ${id}`} aria-hidden="true" />{name}
              </button>
            ))}
          </div>
          {what !== 'list' && (
            <label className="tb-row">
              <input type="checkbox" checked={includeTransitPrint} onChange={(e) => setIncludeTransitPrint(e.target.checked)} />
              <span><b>Include in-transit jobs</b><small>Long-distance jobs only travelling today, as a grey bar.</small></span>
            </label>
          )}
          <button type="button" className="btn tb-go" onClick={() => { close(); onPrint(what, orientation); }}>Print {WHAT.find((w) => w[0] === what)[1].toLowerCase()} · {orientation}</button>
        </>
      )}
    </Menu>
  );
}
