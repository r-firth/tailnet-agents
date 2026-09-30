import { getState } from './store';

/** True when a global single-key shortcut should not fire. */
export function ignoreKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target as HTMLElement | null;
  if (t && (t.closest('input,textarea,select,[contenteditable="true"],[data-capture-keys],.xterm'))) return true;
  const s = getState();
  if (s.paletteOpen || s.overlay) return true;
  return false;
}
