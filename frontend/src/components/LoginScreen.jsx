import { useState } from 'react';

const cardStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 32, width: 360, boxShadow: '0 4px 20px rgba(20,30,60,.08)' };
const fieldStyle = { width: '100%', boxSizing: 'border-box', marginBottom: 12 };
const errorBoxStyle = { background: 'var(--tint-red-bg)', border: '1px solid var(--tint-red-border)', color: 'var(--tint-red-text)', padding: '8px 10px', borderRadius: 8, fontSize: 12, marginBottom: 14 };
const infoBoxStyle = { background: 'var(--tint-blue-bg)', border: '1px solid var(--tint-blue-border)', color: 'var(--tint-blue-text)', padding: '8px 10px', borderRadius: 8, fontSize: 12, marginBottom: 14 };
const linkStyle = { background: 'none', border: 'none', padding: 0, color: 'var(--blue)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' };

function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
      <div className="logo" style={{ background: 'var(--orange)', width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, color: '#fff' }}>ATM</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--heading)' }}>Around Town Movers</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Scheduler login</div>
      </div>
    </div>
  );
}

/**
 * Email + password sign-in, with a "Forgot password?" flow that doubles as first-time password
 * setup — a brand new account (created by an admin with just an email/role, no password) uses the
 * exact same "request a code, then set a password" path as someone who's actually locked out. Three
 * modes swap in place of each other rather than being separate routes/screens, since this is a
 * small, linear flow (login -> forgot -> reset -> back to login on success).
 */
export default function LoginScreen({ onLogin, onForgotPassword, onResetPassword, connectionError, devBypassEnabled, devLoginUrl }) {
  const [mode, setMode] = useState('login'); // 'login' | 'forgot' | 'reset'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  function switchMode(next) {
    setMode(next);
    setError('');
    setInfo('');
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(err.status === 401 ? 'Incorrect email or password.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleForgot(e) {
    e.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      await onForgotPassword(email.trim());
      setInfo("If that email has access, we've sent a 6-digit code to it. Enter it below along with a new password.");
      setMode('reset');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onResetPassword(email.trim(), otp.trim(), newPassword);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={cardStyle}>
        <Logo />

        {connectionError && <div style={errorBoxStyle}>{connectionError}</div>}
        {error && <div style={errorBoxStyle}>{error}</div>}
        {info && <div style={infoBoxStyle}>{info}</div>}

        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <input type="email" style={fieldStyle} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <input type="password" style={fieldStyle} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="submit" className="btn" style={{ width: '100%', boxSizing: 'border-box' }} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div style={{ marginTop: 14, textAlign: 'center' }}>
              <button type="button" style={linkStyle} onClick={() => switchMode('forgot')}>Forgot password, or first time signing in?</button>
            </div>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleForgot}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
              Enter your email and we'll send a 6-digit code you can use to set a password.
            </div>
            <input type="email" style={fieldStyle} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <button type="submit" className="btn" style={{ width: '100%', boxSizing: 'border-box' }} disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between' }}>
              <button type="button" style={linkStyle} onClick={() => switchMode('login')}>Back to sign in</button>
              <button type="button" style={linkStyle} onClick={() => switchMode('reset')}>I already have a code</button>
            </div>
          </form>
        )}

        {mode === 'reset' && (
          <form onSubmit={handleReset}>
            <input type="email" style={fieldStyle} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!email} />
            <input
              type="text" inputMode="numeric" style={fieldStyle} placeholder="6-digit code" value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} required
              autoFocus={Boolean(email)}
            />
            <input type="password" style={fieldStyle} placeholder="New password (8+ characters)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
            <button type="submit" className="btn" style={{ width: '100%', boxSizing: 'border-box' }} disabled={busy}>
              {busy ? 'Setting password…' : 'Set password & sign in'}
            </button>
            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between' }}>
              <button type="button" style={linkStyle} onClick={() => switchMode('login')}>Back to sign in</button>
              <button type="button" style={linkStyle} onClick={() => switchMode('forgot')}>Resend code</button>
            </div>
          </form>
        )}

        {devBypassEnabled && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px dashed var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--tint-amber-text)', background: 'var(--tint-amber-bg)', border: '1px solid var(--tint-amber-border)', borderRadius: 8, padding: '6px 10px', marginBottom: 10, textAlign: 'center' }}>
              Dev mode — sign in without a password. Local dev only.
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {['admin', 'dispatcher', 'crew'].map((role) => (
                <a
                  key={role}
                  href={devLoginUrl(role)}
                  className="btn secondary"
                  style={{ flex: 1, textAlign: 'center', textDecoration: 'none', fontSize: 12, textTransform: 'capitalize' }}
                >
                  {role}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
