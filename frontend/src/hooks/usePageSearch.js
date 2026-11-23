// Page-aware top-bar search. The search box in the title bar (Header) is not tied to one job list any
// more: whichever page is open can "register" its own search (a placeholder, its current text and a
// setter), and the box then searches THAT page's data — Leads search leads, the Storage Tracker
// searches facilities, Users searches users, and so on. A page with nothing to register leaves the
// box to the job search (Board, My Jobs, Long Distance) or hides it.
//
// A tiny external store (not React state in App) so typing in the box only re-renders the box and
// the page that owns the text, not the whole app.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

let current = null; // { id, placeholder, value, onChange } | null
const listeners = new Set();
function emit() { listeners.forEach((l) => l()); }

function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function getSnapshot() { return current; }

/** The page search currently registered by the open page (or null). Used by Header. */
export function useRegisteredPageSearch() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// useLayoutEffect so the box swaps to the new page's search in the same paint as the page itself
// (no one-frame flash of the job search when switching tabs). Falls back to useEffect off-DOM.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Register this page's search with the title bar while it is mounted.
 *   id           unique per search (e.g. 'storage'); only the owner can clear its own registration
 *   enabled      false = don't register (e.g. a sub-tab that isn't showing)
 *   placeholder  text shown in the empty box
 *   value        the page's current search text (the page keeps owning this state)
 *   onChange     the page's setter, called with the new string
 */
export function usePageSearch({ id, enabled = true, placeholder, value, onChange }) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  // One stable function for the store, always calling the latest setter.
  const stableChange = useRef((v) => changeRef.current && changeRef.current(v)).current;

  const valueRef = useRef(value);
  valueRef.current = value;

  // Register / unregister when the page (or its placeholder) changes.
  useIsoLayoutEffect(() => {
    if (!enabled) return undefined;
    current = { id, placeholder, value: valueRef.current ?? '', onChange: stableChange };
    emit();
    return () => {
      if (current && current.id === id) { current = null; emit(); }
    };
  }, [id, enabled, placeholder, stableChange]);

  // Keep the box's text in step with the page's state as it changes (typing, or the page clearing
  // its own filters) without re-registering.
  useIsoLayoutEffect(() => {
    if (!enabled || !current || current.id !== id) return;
    if (current.value === (value ?? '')) return;
    current = { ...current, value: value ?? '' };
    emit();
  }, [id, enabled, value]);
}
