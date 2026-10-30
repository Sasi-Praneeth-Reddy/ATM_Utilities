import { useState } from 'react';
import logo from '../assets/atm-logo.png';

function Logo() {
  return <img className="login-logo" src={logo} alt="Around Town Movers - Moving & Storage" />;
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
  const [showPw, setShowPw] = useState(false);

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

  const titles = {
    login: ['Welcome back', 'Sign in to ATM Hub to manage jobs, crews, storage and leads.'],
    forgot: ['Reset your password', 'We will email you a 6-digit code to set a password.'],
    reset: ['Enter your code', 'Type the code from your email and choose a new password.'],
  };

  return (
    <div className="login-page">
      <aside className="login-side" aria-hidden="true">
        <div className="login-side-inner">
          <div className="login-side-badge">Around Town Movers</div>
          <h2>Every move,<br />perfectly scheduled.</h2>
          <p>Jobs, trucks, crews, storage and leads in one place, built for the way our team works.</p>
          <ul>
            <li>Live day board for every truck</li>
            <li>Leads that flag past customers</li>
            <li>Storage market tracking</li>
          </ul>
        </div>
      </aside>

      <main className="login-main">
      <div className="login-card">
        <Logo />
        <h1 className="login-title">{titles[mode][0]}</h1>
        <p className="login-sub">{titles[mode][1]}</p>

        {connectionError && <div className="login-msg error">{connectionError}</div>}
        {error && <div className="login-msg error">{error}</div>}
        {info && <div className="login-msg info">{info}</div>}

        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <label className="login-label" htmlFor="login-email">Email</label>
            <input id="login-email" type="email" className="login-field" placeholder="you@aroundtownmovers.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
            <label className="login-label" htmlFor="login-password">Password</label>
            <div className="login-pw">
              <input id="login-password" type={showPw ? 'text' : 'password'} className="login-field" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
              <button type="button" className="login-pw-toggle" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? 'Hide' : 'Show'}</button>
            </div>
            <button type="submit" className="login-btn" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div className="login-links center">
              <button type="button" className="login-link" onClick={() => switchMode('forgot')}>Forgot password, or first time signing in?</button>
            </div>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleForgot}>
            <input type="email" className="login-field" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <button type="submit" className="login-btn" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
            <div className="login-links">
              <button type="button" className="login-link" onClick={() => switchMode('login')}>Back to sign in</button>
              <button type="button" className="login-link" onClick={() => switchMode('reset')}>I already have a code</button>
            </div>
          </form>
        )}

        {mode === 'reset' && (
          <form onSubmit={handleReset}>
            <input type="email" className="login-field" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!email} />
            <input
              type="text" inputMode="numeric" className="login-field" placeholder="6-digit code" value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} required
              autoFocus={Boolean(email)}
            />
            <input type="password" className="login-field" placeholder="New password (8+ characters)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
            <button type="submit" className="login-btn" disabled={busy}>
              {busy ? 'Setting password…' : 'Set password & sign in'}
            </button>
            <div className="login-links">
              <button type="button" className="login-link" onClick={() => switchMode('login')}>Back to sign in</button>
              <button type="button" className="login-link" onClick={() => switchMode('forgot')}>Resend code</button>
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
      </main>
    </div>
  );
}
