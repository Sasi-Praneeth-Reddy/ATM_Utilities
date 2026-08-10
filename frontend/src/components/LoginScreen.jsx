const AUTH_ERROR_MESSAGES = {
  wrong_domain: "That Microsoft account isn't an @aroundtownmovers.com address.",
  not_authorized: "That account isn't set up yet. Ask an admin to add you in the Users panel.",
  invalid_state: 'Your sign-in attempt expired or was tampered with — please try again.',
  sign_in_failed: 'Microsoft sign-in failed. Please try again.',
  access_denied: 'Sign-in was cancelled.',
};

function friendlyAuthError(code) {
  if (!code) return '';
  return AUTH_ERROR_MESSAGES[code] || `Sign-in failed (${code}). Please try again.`;
}

export default function LoginScreen({ microsoftLoginUrl, authError, connectionError }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 32, width: 360, boxShadow: '0 4px 20px rgba(20,30,60,.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          <div className="logo" style={{ background: 'var(--orange)', width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, color: '#fff' }}>ATM</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--navy)' }}>Around Town Movers</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Scheduler login</div>
          </div>
        </div>

        {connectionError && (
          <div style={{ background: '#fdecea', border: '1px solid #f2b6b0', color: '#8a1f18', padding: '8px 10px', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
            {connectionError}
          </div>
        )}
        {authError && (
          <div style={{ background: '#fdecea', border: '1px solid #f2b6b0', color: '#8a1f18', padding: '8px 10px', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
            {friendlyAuthError(authError)}
          </div>
        )}

        <a
          href={microsoftLoginUrl}
          className="btn"
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none', boxSizing: 'border-box' }}
        >
          <MicrosoftLogo />
          Sign in with Microsoft
        </a>

        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 16, textAlign: 'center' }}>
          Sign in with your Around Town Movers Microsoft 365 account. Ask your admin for access if
          you don't have one yet.
        </div>
      </div>
    </div>
  );
}

function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="0" y="0" width="7" height="7" fill="#f25022" />
      <rect x="9" y="0" width="7" height="7" fill="#7fba00" />
      <rect x="0" y="9" width="7" height="7" fill="#00a4ef" />
      <rect x="9" y="9" width="7" height="7" fill="#ffb900" />
    </svg>
  );
}
