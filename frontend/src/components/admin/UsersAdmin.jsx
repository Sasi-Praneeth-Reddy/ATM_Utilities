import { useMemo, useState } from 'react';
import { usePageSearch } from '../../hooks/usePageSearch';

const EMAIL_DOMAIN = 'aroundtownmovers.com';
const ROLES = ['admin', 'dispatcher', 'crew'];
// Only an owner or developer may hand out (or touch) those roles, so they are offered only to them.
const TOP_ROLES = ['owner', 'developer'];
const rolesFor = (isTopRole) => (isTopRole ? [...TOP_ROLES, ...ROLES] : ROLES);

function isCompanyEmail(email) {
  return /\S+@\S+/.test(email) && email.trim().toLowerCase().endsWith('@' + EMAIL_DOMAIN);
}

function looksLikeEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}

export function matchesUserQuery(user, q) {
  return user.email.toLowerCase().includes(q) || user.role.toLowerCase().includes(q);
}

/** An email can be granted a user account if it's either a company address, or was explicitly
 * allowed by an admin via the External Access panel below (see db.js's allowedExternalEmails doc
 * comment) — e.g. a partner/subcontractor like paul@campbellmoving.com. `allowedExternalEmails` is
 * the array of {email, ...} entries from that panel. */
function isAllowedEmail(email, allowedExternalEmails) {
  const trimmed = email.trim().toLowerCase();
  if (isCompanyEmail(trimmed)) return true;
  return allowedExternalEmails.some((e) => e.email === trimmed);
}

function AddUserForm({ onSave, onCancel, allowedExternalEmails, isTopRole }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('dispatcher');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = email.trim();
    if (!isAllowedEmail(trimmed, allowedExternalEmails)) {
      setError(`Email must be a @${EMAIL_DOMAIN} address, or added under "External Access" below first.`);
      return;
    }
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
          {rolesFor(isTopRole).map((r) => <option value={r} key={r}>{r}</option>)}
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

/** Lets an admin allow a specific outside-the-company email (e.g. a partner/subcontractor at a
 * different company) to be granted a user account above — adding it here doesn't grant access by
 * itself, it just lifts the @aroundtownmovers.com restriction for that one address so "+ Grant
 * Access" will accept it. See db.js's allowedExternalEmails doc comment for the full reasoning. */
function ExternalAccessPanel({ allowedExternalEmails, onAdd, onRemove }) {
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = email.trim();
    if (!looksLikeEmail(trimmed)) { setError('Enter a valid email address.'); return; }
    if (isCompanyEmail(trimmed)) { setError(`@${EMAIL_DOMAIN} addresses are already allowed — no need to add them here.`); return; }
    setError('');
    setSaving(true);
    try {
      await onAdd(trimmed, note.trim());
      setEmail(''); setNote(''); setShowForm(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(entryEmail) {
    if (!window.confirm(`Remove ${entryEmail} from the allowed list? Their existing account (if any) is untouched — this only blocks granting that email a NEW account later.`)) return;
    try {
      await onRemove(entryEmail);
    } catch (err) {
      window.alert(`Couldn't remove it: ${err.message}`);
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div className="toolbar">
        <h2 className="section-title">External Access — emails outside @{EMAIL_DOMAIN}</h2>
        <button className="btn secondary" onClick={() => setShowForm((v) => !v)}>+ Allow an Email</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Every account above needs a @{EMAIL_DOMAIN} address, except for the ones listed here — a
        one-off allowance for someone outside the company who legitimately needs access, like a
        partner or subcontractor. Adding an email here only lifts that restriction; it doesn't grant
        access by itself — use "+ Grant Access" above afterward to actually create their account and
        pick a role.
      </div>
      {showForm && (
        <div className="admin-card add-form">
          <div className="row"><span className="field-label">Email</span><input type="email" value={email} placeholder="name@theircompany.com" onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="row"><span className="field-label">Note</span><input type="text" value={note} placeholder="e.g. Campbell Moving — partner (optional)" onChange={(e) => setNote(e.target.value)} /></div>
          {error && <div className="sync-msg err">{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Allow Email'}</button>
          </div>
        </div>
      )}
      {allowedExternalEmails.length === 0 ? (
        <div className="empty">No external emails allowed yet.</div>
      ) : (
        allowedExternalEmails.map((entry) => (
          <div className="admin-card" key={entry.email}>
            <h3>{entry.email}</h3>
            {entry.note && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{entry.note}</div>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn secondary" style={{ color: 'var(--red)' }} onClick={() => handleRemove(entry.email)}>Remove from list</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function UserRow({ user, isSelf, isTopRole, onChangeRole, onDelete }) {
  // Only an owner/developer can edit or remove another owner/developer.
  const locked = TOP_ROLES.includes(user.role) && !isTopRole;
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
        <select value={user.role} onChange={(e) => handleRoleChange(e.target.value)} disabled={isSelf || locked}>
          {(locked ? [user.role] : rolesFor(isTopRole)).map((r) => <option value={r} key={r}>{r}</option>)}
        </select>
      </div>
      {!isSelf && !locked && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" style={{ color: 'var(--red)' }} onClick={handleDelete}>Remove access</button>
        </div>
      )}
    </div>
  );
}

export default function UsersAdmin({
  users, currentUserId, isTopRole, onCreateUser, onChangeRole, onDeleteUser,
  allowedExternalEmails, onAddAllowedExternalEmail, onRemoveAllowedExternalEmail,
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [query, setQuery] = useState('');
  // The title-bar search box drives this list's filter (it used to be a second box in this toolbar).
  usePageSearch({ id: 'users', placeholder: 'Search users (email, role)…', value: query, onChange: setQuery });

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
        <h2 className="section-title">Users — who can access ATM Hub</h2>
        <button className="btn" onClick={() => setShowAddForm((v) => !v)}>+ Grant Access</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Everyone signs in with an email + password — only @{EMAIL_DOMAIN} addresses can be granted
        access, unless the email's been added under "External Access" below. New accounts start
        with no password; the person sets their own via "Forgot password?" on the sign-in screen (a
        6-digit code is emailed to them). <b>Owner</b> and <b>Developer</b> are above Admin: everything an admin can do, plus seeing every task and granting those two roles. <b>Admin</b> has full access except managing users (this panel).
        <b>Dispatcher</b> can assign/move jobs but not edit truck/driver records or users.
        <b>Crew</b> is read-only.
      </div>
      {showAddForm && <AddUserForm onSave={handleSave} onCancel={() => setShowAddForm(false)} allowedExternalEmails={allowedExternalEmails} isTopRole={isTopRole} />}
      {query.trim() && !filteredUsers.length ? (
        <div className="empty">No users match "{query}".</div>
      ) : (
        filteredUsers.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            isSelf={u.id === currentUserId}
            isTopRole={isTopRole}
            onChangeRole={onChangeRole}
            onDelete={onDeleteUser}
          />
        ))
      )}
      <ExternalAccessPanel
        allowedExternalEmails={allowedExternalEmails}
        onAdd={onAddAllowedExternalEmail}
        onRemove={onRemoveAllowedExternalEmail}
      />
    </div>
  );
}
