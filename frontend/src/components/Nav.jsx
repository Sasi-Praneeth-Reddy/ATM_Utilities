import { TAB_LABELS } from './shell/modules';

/** Page-level tab strip for the active module. `alertTabs`: { [tabId]: 'tooltip' } shows a red dot.
    Kept as the page's single <nav> element — DayBoard.jsx measures document.querySelector('nav')
    to size its sticky tray, so the sidebar deliberately does NOT use a <nav> tag. */
export default function Nav({ tabIds, activeTab, onTabChange, alertTabs = {} }) {
  return (
    <nav className="tabstrip">
      {tabIds.map((id) => (
        <button key={id} className={activeTab === id ? 'active' : ''} onClick={() => onTabChange(id)}>
          {TAB_LABELS[id] || id}
          {alertTabs[id] && (
            <span className="nav-alert-dot" title={alertTabs[id]} aria-label={alertTabs[id]} />
          )}
        </button>
      ))}
    </nav>
  );
}
