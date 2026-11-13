import { visibleModules } from './modules';
import logo from '../../assets/atm-logo.png';
import CreditMark from '../CreditMark';
import { APP_VERSION, SUPPORT_EMAIL, CREDIT } from '../../version';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' };

const ICONS = {
  tasking: <><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></>,
  dispatch: <><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" /></>,
  tasks: <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  storage: <><path d="M22 8.35V20a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8.35A1 1 0 0 1 2.65 7.4l9-3.6a1 1 0 0 1 .7 0l9 3.6A1 1 0 0 1 22 8.35Z" /><path d="M6 18h12" /><path d="M6 14h12" /><rect width="12" height="12" x="6" y="10" /></>,
  military: <><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></>,
  longdist: <><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></>,
  referrals: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  leads: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></>,
  market: <><path d="M3 3v18h18" /><path d="M7 16V11" /><path d="M12 16V7" /><path d="M17 16v-3" /></>,
  map: <><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></>,
  kpis: <><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  sparkle: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
};

export function Icon({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none' }} {...P}>
      {ICONS[name]}
    </svg>
  );
}

export default function Sidebar({ role, isTopRole, activeModuleId, onSelectModule, collapsed, onToggle, alertModules = {} }) {
  const mods = visibleModules(role, isTopRole);

  return (
    <>
      {!collapsed && <div className="shell-backdrop" onClick={onToggle} aria-hidden="true" />}
      <aside className={`shell-sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Modules">
        <div className="shell-brand">
          <div className="shell-logo">ATM</div>
          <img className="shell-logo-img" src={logo} alt="Around Town Movers" />
        </div>
        <div className="shell-modules" role="navigation" aria-label="Main modules">
          {mods.map((m) => {
            const active = m.id === activeModuleId;
            return (
              <button
                key={m.id}
                type="button"
                className={`shell-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? m.label : undefined}
                onClick={() => onSelectModule(m)}
              >
                <Icon name={m.icon} />
                <span className="shell-label">{m.label}</span>
                {m.soon && <span className="shell-soon">Soon</span>}
                {m.badge && <span className="shell-new">{m.badge}</span>}
                {alertModules[m.id] && <span className="nav-alert-dot" title={alertModules[m.id]} aria-label={alertModules[m.id]} />}
              </button>
            );
          })}
        </div>
        {/* Collapse control lives at the bottom as a regular full-size row (same look as the module
            rows), so it can't get clipped in the narrow icon rail the way a small title-row button did. */}
        <div className="shell-version" title={`ATM Hub version ${APP_VERSION}. ${CREDIT}.`}>
          <CreditMark className="shell-mark" />
          v{APP_VERSION}
          <a className="shell-support" href={`mailto:${SUPPORT_EMAIL}?subject=ATM%20Hub%20issue`} title={`${CREDIT}. Something buggy? ${SUPPORT_EMAIL}`}>Report a bug</a>
        </div>
        <button type="button" className="shell-item shell-collapse" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none', transform: collapsed ? 'scaleX(-1)' : 'none' }} {...P}>
            <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m15 10-2 2 2 2" />
          </svg>
          <span className="shell-label">Collapse</span>
        </button>
      </aside>
    </>
  );
}
