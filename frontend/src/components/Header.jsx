export default function Header({ user, onLogout, role, trucks, crewTruck, onCrewTruckChange }) {
  return (
    <header>
      <div className="brand">
        <div className="logo">ATM</div>
        <div>
          <h1>Around Town Movers</h1>
          <span>Scheduler</span>
        </div>
      </div>
      <div className="role-switch">
        {role === 'crew' && (
          <select value={crewTruck} onChange={(e) => onCrewTruckChange(e.target.value)}>
            {trucks.map((t) => (
              <option key={t.id} value={t.id}>{t.name} — {t.size}</option>
            ))}
          </select>
        )}
        <span>{user.email} <span style={{ opacity: 0.7 }}>({role})</span></span>
        <button className="btn secondary" onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}
