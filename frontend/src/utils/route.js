// Tiny hash router so a browser refresh (or a bookmarked/shared link) lands on the same page.
//   #/leads            -> a top-level tab
//   #/leads/matches    -> a tab plus the sub-view inside it
//   #/soon-military    -> a "coming soon" module
// Only the hash is used, so there is nothing to configure on Firebase Hosting.

export function readRoute() {
  if (typeof window === 'undefined') return { tab: null, sub: null };
  const h = (window.location.hash || '').replace(/^#\/?/, '');
  const [tab, sub] = h.split('/');
  return { tab: tab || null, sub: sub || null };
}

/** Writes the route. `sub` undefined = keep the current sub-view if we are still on the same tab. */
export function writeRoute(tab, sub) {
  if (typeof window === 'undefined' || !tab) return;
  const cur = readRoute();
  const nextSub = sub === undefined ? (cur.tab === tab ? cur.sub : null) : sub;
  const hash = `#/${tab}${nextSub ? `/${nextSub}` : ''}`;
  if (window.location.hash !== hash) {
    try { window.history.pushState(null, '', hash); } catch { window.location.hash = hash; }
  }
}
