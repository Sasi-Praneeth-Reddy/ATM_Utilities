/**
 * Full-screen loading animation (added 2026-09-30) — shown while the session is being checked and
 * while the first /api/state load is in flight, instead of a bare "Loading…" line (and instead of
 * the "Can't reach the backend" banner that used to flash for a split second before the first
 * response arrived). A moving truck on a scrolling road, in the app's navy/orange brand colours.
 * Pure CSS (see .loading-screen in styles.css); respects prefers-reduced-motion.
 */
export default function LoadingScreen({ message = 'Loading the scheduler' }) {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-scene" aria-hidden="true">
        <svg className="loading-truck" viewBox="0 0 120 64" width="120" height="64">
          {/* cargo box */}
          <rect x="4" y="8" width="70" height="38" rx="4" className="lt-box" />
          <rect x="12" y="18" width="30" height="5" rx="2.5" className="lt-stripe" />
          {/* cab */}
          <path d="M76 20 h22 l14 14 v12 h-36 z" className="lt-cab" />
          <path d="M82 25 h13 l9 9 h-22 z" className="lt-window" />
          {/* wheels */}
          <g className="lt-wheel" style={{ transformOrigin: '24px 50px' }}>
            <circle cx="24" cy="50" r="8" className="lt-tire" />
            <circle cx="24" cy="50" r="3" className="lt-hub" />
            <rect x="23" y="43" width="2" height="4" className="lt-hub" />
          </g>
          <g className="lt-wheel" style={{ transformOrigin: '92px 50px' }}>
            <circle cx="92" cy="50" r="8" className="lt-tire" />
            <circle cx="92" cy="50" r="3" className="lt-hub" />
            <rect x="91" y="43" width="2" height="4" className="lt-hub" />
          </g>
        </svg>
        <div className="loading-road" />
      </div>
      <div className="loading-text">{message}</div>
    </div>
  );
}
