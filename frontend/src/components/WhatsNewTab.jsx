import { RELEASES } from '../data/releaseNotes';
import CreditMark from './CreditMark';
import { APP_NAME, APP_VERSION, SUPPORT_EMAIL, CREDIT } from '../version';

const STAFF = ['admin', 'dispatcher'];

function visibleTo(item, role) {
  if (item.audience === 'admin') return role === 'admin';
  if (item.audience === 'staff') return STAFF.includes(role);
  return true;
}

function Section({ heading, hint, items, kind }) {
  if (!items.length) return null;
  return (
    <section className={`wn-section wn-${kind}`}>
      <h3>{heading}</h3>
      {hint && <p className="wn-hint">{hint}</p>}
      <ul className="wn-list">
        {items.map((it) => (
          <li key={it.title}>
            <strong>{it.title}</strong>
            <span>{it.body}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "What's New" page: release notes for each version, newest first (content: data/releaseNotes.js).
    Items are filtered by the viewer's role so nobody reads about screens they cannot open. */
export default function WhatsNewTab({ role }) {
  return (
    <div className="wn-page">
      {RELEASES.map((rel, i) => (
        <article key={rel.version} className="wn-release">
          <header className="wn-head">
            <div>
              <span className="wn-badge">{i === 0 ? 'Latest' : 'Earlier'}</span>
              <h2>{rel.name}</h2>
              <p>{rel.tagline}</p>
            </div>
            <div className="wn-meta">
              <strong>v{rel.version}</strong>
              <span>{new Date(`${rel.date}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>
              {rel.version === APP_VERSION && <span className="wn-current">You are on this version</span>}
            </div>
          </header>
          <div className="wn-grid">
            <Section kind="new" heading="What's new" items={rel.new.filter((x) => visibleTo(x, role))} />
            <Section kind="changing" heading="What's changing" items={rel.changing.filter((x) => visibleTo(x, role))} />
            <Section kind="upcoming" heading="Coming up" hint={rel.upcomingNote} items={rel.upcoming.filter((x) => visibleTo(x, role))} />
          </div>
        </article>
      ))}
      <p className="wn-foot"><CreditMark /><br />{APP_NAME} v{APP_VERSION}. {CREDIT}. Something not working? Email <a href={`mailto:${SUPPORT_EMAIL}?subject=ATM%20Hub%20issue`}>{SUPPORT_EMAIL}</a>.</p>
    </div>
  );
}
