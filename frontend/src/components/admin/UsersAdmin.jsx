import { useState } from 'react';

const EMAIL_DOMAIN = 'aroundtownmovers.com';
const ROLES = ['admin', 'dispatcher', 'crew'];

function isCompanyEmail(email) {
  return /\S+@\S+/.test(email) && email.trim().toLowerCase().endsWith('@' + EMAIL_DOMAIN);
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
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>No password to set — they'll sign in with their own Microsoft 365 account.</div>
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

  async function handleSave(fields) {
    await onCreateUser(fields);
    setShowAddForm(false);
  }

  return (
    <div>
      <div className="toolbar">
        <h2 className="section-title">Users — who can access the scheduler</h2>
        <button className="btn" onClick={() => setShowAddForm((v) => !v)}>+ Grant Access</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Everyone signs in with their Around Town Movers Microsoft 365 account — only
        @{EMAIL_DOMAIN} addresses can be granted access. <b>Admin</b> has full access including this
        panel. <b>Dispatcher</b> can assign/move jobs but not edit truck/driver records or users.
        <b> Crew</b> is read-only.
      </div>
      {showAddForm && <AddUserForm onSave={handleSave} onCancel={() => setShowAddForm(false)} />}
      {users.map((u) => (
        <UserRow
          key={u.id}
          user={u}
          isSelf={u.id === currentUserId}
          onChangeRole={onChangeRole}
          onDelete={onDeleteUser}
        />
      ))}
    </div>
  );
}
