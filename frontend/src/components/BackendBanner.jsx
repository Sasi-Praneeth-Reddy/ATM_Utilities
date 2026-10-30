import { useState } from 'react';

export default function BackendBanner({ backendConnected, backendErrorMsg, backendUrl, onRetryUrl }) {
  const [urlInput, setUrlInput] = useState(backendUrl);

  if (!backendConnected) {
    // Production (same-origin hosting, backendUrl === '' — see api.js): a plain, non-technical
    // message. The localhost / `npm start` / custom-URL form below only makes sense for local dev,
    // and was confusing for dispatchers (2026-09-30).
    if (!backendUrl) {
      return (
        <div className="conflict-banner">
          <div className="cb-title">⚠ Can't connect to the ATM Hub server</div>
          Check your internet connection. The board will reconnect automatically, or you can try again now.
          <div className="sync-row" style={{ marginTop: 8 }}>
            <button className="btn secondary" onClick={() => window.location.reload()}>Try again</button>
          </div>
        </div>
      );
    }
    const where = backendUrl;
    return (
      <div className="conflict-banner">
        <div className="cb-title">⚠ Can't reach the backend at {where}</div>
        This scheduler now stores everything in a shared database, so it needs the backend running to
        load or save anything. Start it with <code>cd server && npm start</code>, or set a different
        backend URL below, then reload.
        <div className="sync-row" style={{ marginTop: 8 }}>
          <input
            type="text"
            value={urlInput}
            placeholder="http://localhost:8787"
            onChange={(e) => setUrlInput(e.target.value)}
          />
          <button className="btn secondary" onClick={() => onRetryUrl(urlInput)}>Retry</button>
        </div>
      </div>
    );
  }
  if (backendErrorMsg) {
    return (
      <div className="conflict-banner">
        <div className="cb-title">⚠ Save failed</div>
        {backendErrorMsg}
      </div>
    );
  }
  return null;
}
