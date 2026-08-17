import { useEffect, useRef, useState } from 'react';
import ConflictBanner from '../ConflictBanner';
import DriverLegend from '../DriverLegend';
import DayBoard from './DayBoard';
import MonthBoard from './MonthBoard';
import DayPrintSheet from './DayPrintSheet';
import DayPrintTimeline from './DayPrintTimeline';
import JobSearch from './JobSearch';
import { useDragAutoScroll } from '../../hooks/useDragAutoScroll';
import { todayStr } from '../../utils/dates';

// Both print sheets are always in the DOM (hidden on screen) so printing never has to wait on a
// React re-render. Which one shows up on paper is decided by a plain DOM class toggle right before
// window.print() is called — deliberately not React state, since setState + window.print() in the
// same click handler risks the browser printing the PREVIOUS render (state updates are async;
// print() isn't) if you don't add an effect to sequence them. A synchronous classList toggle has
// no such race.
function printSheet(id) {
  document.querySelectorAll('.print-sheet').forEach((el) => el.classList.remove('print-active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('print-active');
  window.print();
}

export default function BoardTab({
  role, boardMode, setBoardMode, boardDate, setBoardDate, monthCursor, setMonthCursor,
  trucks, drivers, jobs, currentCrewTruck, conflicts, conflictIds,
  onUnassignJob, onAddTruckToJob, onRemoveTruck, onMoveJobDate, onAddExtraTruck, onUpdateJobFields,
  onCreateJob, onDeleteJob,
}) {
  const title = role === 'crew'
    ? 'Company truck board — view only'
    : "Drag a job onto a truck's row (day view) or a date (month view) to assign it";

  // Lets the page auto-scroll while dragging a job near the top or bottom of the screen — see
  // useDragAutoScroll's doc comment for why this can't just rely on the browser's native
  // drag-auto-scroll (it silently fails at the top edge here because of the sticky header/nav).
  // Also auto-scrolls the day view's timeline left/right near ITS edges — timelineRef is owned
  // here (not inside DayBoard) so the same ref can both be handed to the hook and passed down to
  // DayBoard to attach to the actual scrollable element.
  const timelineRef = useRef(null);
  useDragAutoScroll({ horizontalScrollRef: timelineRef });

  // Search always jumps to day view — that's the one place a job's exact truck/time is visible —
  // and briefly highlights the job once the board lands on its date, so "find this job" ends with
  // actually seeing it, not just guessing it's somewhere on the right day.
  const [highlightedJobId, setHighlightedJobId] = useState(null);
  useEffect(() => {
    if (!highlightedJobId) return undefined;
    const timer = setTimeout(() => setHighlightedJobId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightedJobId]);

  function handleJumpToJob(job) {
    setBoardMode('day');
    setBoardDate(job.date);
    setMonthCursor(new Date(`${job.date}T00:00:00`));
    setHighlightedJobId(job.id);
  }

  return (
    <section>
      <div className="toolbar">
        <h2 className="section-title">{title}</h2>
        <JobSearch jobs={jobs} trucks={trucks} onJumpToJob={handleJumpToJob} />
        <div className="board-controls">
          <div className="view-toggle">
            <button className={`btn secondary ${boardMode === 'day' ? 'active' : ''}`} onClick={() => setBoardMode('day')}>Day</button>
            <button className={`btn secondary ${boardMode === 'month' ? 'active' : ''}`} onClick={() => setBoardMode('month')}>Month</button>
          </div>
          {boardMode === 'day' ? (
            <div className="datepick">
              <span>Date:</span>
              <input type="date" value={boardDate} onChange={(e) => setBoardDate(e.target.value)} />
              <button className="btn secondary" onClick={() => setBoardDate(todayStr())} title="Jump to today — the same date the now-line marks on the timeline">Today</button>
              <button className="btn secondary" onClick={() => printSheet('day-print-list')} title="Print a plain text list of the day's jobs">🖨 Print List</button>
              <button className="btn secondary" onClick={() => printSheet('day-print-timeline')} title="Print the truck board as it looks on screen — colors, bars, trucks on the left">🖨 Print Board</button>
            </div>
          ) : (
            <div className="monthpick">
              <button className="btn secondary" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))}>‹</button>
              <span>{monthCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
              <button className="btn secondary" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))}>›</button>
            </div>
          )}
        </div>
      </div>

      <ConflictBanner conflicts={conflicts} trucks={trucks} drivers={drivers} />
      <DriverLegend trucks={trucks} drivers={drivers} />

      {boardMode === 'day' ? (
        <>
          <DayBoard
            date={boardDate}
            trucks={trucks}
            drivers={drivers}
            jobs={jobs}
            role={role}
            conflictIds={conflictIds}
            onUnassignJob={onUnassignJob}
            onAddTruckToJob={onAddTruckToJob}
            onRemoveTruck={onRemoveTruck}
            onAddExtraTruck={onAddExtraTruck}
            onUpdateJobFields={onUpdateJobFields}
            onCreateJob={onCreateJob}
            onDeleteJob={onDeleteJob}
            highlightedJobId={highlightedJobId}
            timelineRef={timelineRef}
          />
          <DayPrintSheet id="day-print-list" date={boardDate} trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds} />
          <DayPrintTimeline id="day-print-timeline" date={boardDate} trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds} />
        </>
      ) : (
        <MonthBoard
          monthCursor={monthCursor}
          trucks={trucks}
          drivers={drivers}
          jobs={jobs}
          role={role}
          currentCrewTruck={currentCrewTruck}
          conflicts={conflicts}
          conflictIds={conflictIds}
          onMoveJobDate={onMoveJobDate}
          onAddExtraTruck={onAddExtraTruck}
        />
      )}
    </section>
  );
}
