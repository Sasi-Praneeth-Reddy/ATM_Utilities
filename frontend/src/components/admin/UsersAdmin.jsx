import { useMemo, useState } from 'react';

const EMAIL_DOMAIN = 'aroundtownmovers.com';
const ROLES = ['admin', 'dispatcher', 'crew'];

function isCompanyEmail(email) {
  return /\S+@\S+/.test(email) && email.trim().toLowerCase().endsWith('@' + EMAIL_DOMAIN);
}

export function matchesUserQuery(user, q) {
  return user.email.toLowerCase().includes(q) || user.role.toLowerCase().includes(q);
}

function AddUserForm({ onSave, onCancel }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('dispatcher');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = email.trim();
    if (!isCompanyEmail(trimmed)) { setError(`Email must be a @${EMAIL_DOMAIN} address.`); return; }
    setError('');
    setSaving(true);
    try {
      await onSave({ email: trimmed, role });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-card add-form">
      <h3>Grant Access</h3>
      <div className="row"><span className="field-label">Email</span><input type="email" value={email} placeholder={`name@${EMAIL_DOMAIN}`} onChange={(e) => setEmail(e.target.value)} /></div>
      <div className="row">
        <span className="field-label">Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => <option value={r} key={r}>{r}</option>)}
        </select>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>No password to set here — they'll use "Forgot password?" on the sign-in screen to set one themselves via an emailed code.</div>
      {error && <div className="sync-msg err">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn secondary" onClick={onCancel}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Grant Access'}</button>
      </div>
    </div>
  );
}

function UserRow({ user, isSelf, onChangeRole, onDelete }) {
  async function handleRoleChange(newRole) {
    try {
      await onChangeRole(user.id, newRole);
    } catch (err) {
      window.alert(`Couldn't change role: ${err.message}`);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Remove ${user.email}'s access? They won't be able to sign in anymore.`)) return;
    try {
      await onDelete(user.id);
    } catch (err) {
      window.alert(`Couldn't remove user: ${err.message}`);
    }
  }

  return (
    <div className="admin-card">
      <h3>
        {user.email}{isSelf && <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}> (you)</span>}
        {!user.hasPassword && (
          <span style={{ color: 'var(--tint-amber-text)', background: 'var(--tint-amber-bg)', border: '1px solid var(--tint-amber-border)', fontWeight: 700, fontSize: 9, padding: '1px 6px', borderRadius: 9, marginLeft: 6, verticalAlign: 'middle' }}>
            NO PASSWORD YET
          </span>
        )}
      </h3>
      <div className="row">
        <span className="field-label">Role</span>
        <select value={user.role} onChange={(e) => handleRoleChange(e.target.value)} disabled={isSelf}>
          {ROLES.map((r) => <option value={r} key={r}>{r}</option>)}
        </select>
      </div>
      {!isSelf && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" style={{ color: 'var(--red)' }} onClick={handleDelete}>Remove access</button>
        </div>
      )}
    </div>
  );
}

export default function UsersAdmin({ users, currentUserId, onCreateUser, onChangeRole, onDeleteUser }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [query, setQuery] = useState('');

  async function handleSave(fields) {
    await onCreateUser(fields);
    setShowAddForm(false);
  }

  // Plain filter-as-you-type over email and role — this list stays short in practice, but a
  // search bar here keeps it consistent with Job Assignments' filter and makes finding one person
  // in a longer list a lot faster than scanning.
  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => matchesUserQuery(u, q));
  }, [users, query]);

  return (
    <div>
      <div className="toolbar">
        <h2 className="section-title">Users — who can access the scheduler</h2>
        <div className="list-filter">
          <input
            type="text"
            className="job-search-input"
            placeholder="Search users (email, role)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="btn" onClick={() => setShowAddForm((v) => !v)}>+ Grant Access</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Everyone signs in with an email + password — only @{EMAIL_DOMAIN} addresses can be granted
        access. New accounts start with no password; the person sets their own via "Forgot
        password?" on the sign-in screen (a 6-digit code is emailed to them). <b>Admin</b> has full
        access including this panel. <b>Dispatcher</b> can assign/move jobs but not edit
        truck/driver records or users. <b>Crew</b> is read-only.
      </div>
      {showAddForm && <AddUserForm onSave={handleSave} onCancel={() => setShowAddForm(false)} />}
      {query.trim() && !filteredUsers.length ? (
        <div className="empty">No users match "{query}".</div>
      ) : (
        filteredUsers.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            isSelf={u.id === currentUserId}
            onChangeRole={onChangeRole}
            onDelete={onDeleteUser}
          />
        ))
      )}
    </div>
  );
}
