import { useState } from 'react';

export default function BackendBanner({ backendConnected, backendErrorMsg, backendUrl, onRetryUrl }) {
  const [urlInput, setUrlInput] = useState(backendUrl);

  if (!backendConnected) {
    // backendUrl is '' for same-origin production hosting (see api.js) — name it explicitly
    // instead of showing a blank.
    const where = backendUrl || 'this site';
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
