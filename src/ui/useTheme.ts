/**
 * Theme application.
 *
 * The stored preference lives in the meta row like everything else, but it is
 * also mirrored to localStorage so the first paint doesn't flash the wrong
 * theme while IndexedDB opens. localStorage here is a per-viewer convenience
 * only — the meta row is the source of truth, and it wins on any disagreement.
 */

import { useEffect, useState } from 'react';
import type { Settings } from '../db/types';

export type Theme = Settings['theme'];
/** What is actually on screen — 'system' resolved against the OS setting. */
export type EffectiveTheme = 'light' | 'dark';

const LS_KEY = 'cloze.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function readCachedTheme(): Theme {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* private mode, blocked storage — fall through to the default */
  }
  return 'system';
}

export function systemTheme(): EffectiveTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function resolveTheme(theme: Theme): EffectiveTheme {
  return theme === 'system' ? systemTheme() : theme;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(LS_KEY, theme);
  } catch {
    /* non-fatal */
  }
}

export function useTheme(theme: Theme | undefined): void {
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
}

/**
 * The theme currently on screen, tracking the OS setting while the preference
 * is 'system'. The toggle needs this: from 'system' it has to flip to the
 * opposite of what you are actually looking at, not to some fixed default.
 */
export function useEffectiveTheme(theme: Theme | undefined): EffectiveTheme {
  const [system, setSystem] = useState<EffectiveTheme>(systemTheme);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  if (!theme || theme === 'system') return system;
  return theme;
}
