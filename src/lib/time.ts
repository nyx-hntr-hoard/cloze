/**
 * Study-day arithmetic.
 *
 * A "study day" does not start at midnight. With a rollover hour of 4, a
 * session at 1am Tuesday belongs to Monday's day — which is what you want when
 * you study late and expect your streak and daily limits to behave.
 */

import type { Millis } from '../db/types';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * The instant the current study day began, for a given `now` and rollover hour.
 * Works in local time, which is what the user experiences.
 */
export function dayStart(now: Millis, rolloverHour: number): Millis {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), rolloverHour, 0, 0, 0);
  if (start.getTime() > now) {
    // We're before today's rollover, so we're still in yesterday's study day.
    start.setDate(start.getDate() - 1);
  }
  return start.getTime();
}

/** The instant the current study day ends (== start of the next one). */
export function dayEnd(now: Millis, rolloverHour: number): Millis {
  const start = new Date(dayStart(now, rolloverHour));
  start.setDate(start.getDate() + 1);
  return start.getTime();
}

/**
 * An integer day number for a timestamp, so two timestamps can be compared for
 * "same study day" and daily counts can be bucketed.
 */
export function studyDayNumber(at: Millis, rolloverHour: number): number {
  return Math.floor(dayStart(at, rolloverHour) / DAY);
}

/** Human-readable interval, matching the way Anki labels answer buttons. */
export function formatInterval(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30).toFixed(1)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** Relative date for list views: "today", "in 3d", "5d ago". */
export function formatDue(due: Millis, now: Millis = Date.now()): string {
  const delta = due - now;
  if (delta <= 0) return 'due';
  return `in ${formatInterval(delta)}`;
}

export function formatDate(at: Millis): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
