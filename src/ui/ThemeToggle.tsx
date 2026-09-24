/**
 * One-click light/dark switch for the header.
 *
 * Settings keeps the full three-way control including "System"; this is the
 * shortcut, because a theme buried two screens away is one you stop using. From
 * "System" it flips to the opposite of whatever is currently on screen, which is
 * what clicking a light/dark toggle is understood to mean.
 */

import { updateSettings } from '../repo';
import { applyTheme, useEffectiveTheme, type Theme } from './useTheme';

export function ThemeToggle({ theme }: { theme: Theme | undefined }) {
  const effective = useEffectiveTheme(theme);
  const next: Theme = effective === 'dark' ? 'light' : 'dark';

  function toggle() {
    // Apply immediately so the switch feels instant, then persist. The live
    // query will settle on the same value a moment later.
    applyTheme(next);
    void updateSettings({ theme: next });
  }

  return (
    <button
      type="button"
      className="ghost theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode${theme === 'system' ? ' (currently following your system)' : ''}`}
    >
      {effective === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <line x1="12" y1="1.8" x2="12" y2="4" />
        <line x1="12" y1="20" x2="12" y2="22.2" />
        <line x1="1.8" y1="12" x2="4" y2="12" />
        <line x1="20" y1="12" x2="22.2" y2="12" />
        <line x1="4.6" y1="4.6" x2="6.2" y2="6.2" />
        <line x1="17.8" y1="17.8" x2="19.4" y2="19.4" />
        <line x1="4.6" y1="19.4" x2="6.2" y2="17.8" />
        <line x1="17.8" y1="6.2" x2="19.4" y2="4.6" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"
        fill="currentColor"
      />
    </svg>
  );
}
