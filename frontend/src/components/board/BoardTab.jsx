import ConflictBanner from '../ConflictBanner';
import DriverLegend from '../DriverLegend';
import DayBoard from './DayBoard';
import MonthBoard from './MonthBoard';

const SAMPLE_DATA_TODAY = '2026-08-05'; // matches the seeded sample data's date range

export default function BoardTab({
  role, boardMode, setBoardMode, boardDate, setBoardDate, monthCursor, setMonthCursor,
  trucks, drivers, jobs, currentCrewTruck, conflicts, conflictIds,
  onUnassignJob, onAddTruckToJob, onRemoveTruck, onMoveJobDate,
}) {
  const title = role === 'crew'
    ? 'Company truck board — view only'
    : "Drag a job onto a truck's row (day view) or a date (month view) to assign it";

  return (
    <section>
      <div className="toolbar">
        <h2 className="section-title">{title}</h2>
        <div className="board-controls">
          <div className="view-toggle">
            <button className={`btn secondary ${boardMode === 'day' ? 'active' : ''}`} onClick={() => setBoardMode('day')}>Day</button>
            <button className={`btn secondary ${boardMode === 'month' ? 'active' : ''}`} onClick={() => setBoardMode('month')}>Month</button>
          </div>
          {boardMode === 'day' ? (
            <div className="datepick">
              <span>Date:</span>
              <input type="date" value={boardDate} onChange={(e) => setBoardDate(e.target.value)} />
              <button className="btn secondary" onClick={() => setBoardDate(SAMPLE_DATA_TODAY)}>Today</button>
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
        />
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
        />
      )}
    </section>
  );
}
