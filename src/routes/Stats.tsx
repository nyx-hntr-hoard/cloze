/**
 * Stats: what you've done, what's coming, and how well it's sticking.
 *
 * All figures come from `src/stats` (pure) over cards and a year of review
 * logs, loaded once per database change. The deck and history range live in
 * the URL like Browse's search, and both scope everything on the page.
 *
 * Retention here is *true retention* — the pass rate on graduated cards —
 * because that's the number desired retention is a promise about. When the two
 * drift apart, the page points at the optimizer.
 */

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { getFsrsParams, getSettings, listDecks, loadStatsData } from '../repo';
import {
  cardCounts,
  daysAgo,
  dueForecast,
  groupDays,
  retention,
  reviewHistory,
  streak,
  type DayActivity,
} from '../stats';
import { DAY } from '../lib/time';
import { plural } from '../lib/text';
import { BarChart, type BarSeries } from '../ui/BarChart';

const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
] as const;

const FORECAST_DAYS = 30;

// Stack order is the validated order: review at the base, then learning, then new.
const HISTORY_SERIES: BarSeries[] = [
  { name: 'Review', color: 'var(--viz-review)' },
  { name: 'Learning', color: 'var(--viz-learning)' },
  { name: 'New', color: 'var(--viz-new)' },
];
const FORECAST_SERIES: BarSeries[] = [{ name: 'Due', color: 'var(--viz-review)' }];

const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * How the history chart is drawn for a range: daily columns up to 90 days,
 * weekly past that, and how often to label a column (counting back from the
 * last, so the latest column is always labeled).
 */
function historyShape(days: number): { bucket: number; every: number } {
  if (days <= 31) return { bucket: 1, every: 7 };
  if (days <= 92) return { bucket: 1, every: 14 };
  return { bucket: 7, every: 9 };
}

function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="tile">
      <div className="tile__label">{label}</div>
      <div className="tile__value">{value}</div>
      {sub ? <div className="tile__sub">{sub}</div> : null}
    </div>
  );
}

export function Stats() {
  const [params, setParams] = useSearchParams();
  const deckId = params.get('deck') || null;
  const rangeParam = Number(params.get('range'));
  const range = RANGES.find((r) => r.days === rangeParam)?.days ?? 30;

  function set(key: string, value: string | null) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  const decks = useLiveQuery(() => listDecks(), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const fsrs = useLiveQuery(() => getFsrsParams(), []);
  // A year and a day of logs covers every range and a year-long streak.
  const data = useLiveQuery(async () => {
    const loadedAt = Date.now();
    return { ...(await loadStatsData(deckId, loadedAt - 366 * DAY)), loadedAt };
  }, [deckId]);

  const rollover = settings?.rolloverHour ?? 4;

  const view = useMemo(() => {
    if (!data) return null;
    const now = data.loadedAt;
    const history = reviewHistory(data.logs, range, now, rollover);
    const forecast = dueForecast(data.cards, FORECAST_DAYS, now, rollover);
    const today = history[history.length - 1];
    const answered = (d: DayActivity) => d.new + d.learning + d.review;
    const inRange = history.reduce((n, d) => n + answered(d), 0);
    const { bucket, every } = historyShape(range);
    const columns = groupDays(history, bucket);

    return {
      today: { n: answered(today), ms: today.ms },
      inRange,
      activeDays: history.filter((d) => answered(d) > 0).length,
      retention: retention(data.logs, daysAgo(now, rollover, range - 1)),
      streak: streak(data.logs, now, rollover),
      counts: cardCounts(data.cards),
      forecast,
      weekDue: forecast.slice(0, 7).reduce((n, d) => n + d.due, 0),
      weekly: bucket > 1,
      historyData: columns.map((d, i) => {
        const last = i === columns.length - 1;
        return {
          label: bucket > 1 ? (last ? 'This week' : `Week of ${shortDate(d.day)}`) : longDate(d.day),
          tick: last ? (bucket > 1 ? 'This week' : 'Today') : (columns.length - 1 - i) % every === 0 ? shortDate(d.day) : '',
          values: [d.review, d.learning, d.new],
        };
      }),
      forecastData: forecast.map((d, i) => ({
        label: i === 0 ? `Today (with anything overdue)` : longDate(d.day),
        tick: i === 0 ? 'Today' : i % 7 === 0 ? shortDate(d.day) : '',
        values: [d.due],
      })),
      hasAnything: data.cards.length > 0 || data.logs.length > 0,
    };
  }, [data, range, rollover]);

  const target = fsrs?.requestRetention ?? 0.9;
  const rate = view?.retention.rate ?? null;
  // Only worth flagging with enough reviews to mean something.
  const drift = rate !== null && view!.retention.total >= 50 && Math.abs(rate - target) >= 0.04;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stats</h1>
          <p className="muted small">Study days start at {String(rollover).padStart(2, '0')}:00.</p>
        </div>
      </div>

      <div className="stats__filters">
        <label htmlFor="stats-deck" className="sr-only">
          Deck
        </label>
        <select id="stats-deck" value={deckId ?? ''} onChange={(e) => set('deck', e.target.value || null)}>
          <option value="">All decks</option>
          {(decks ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <div className="typeswitch" role="group" aria-label="History range">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              className={range === r.days ? 'on' : ''}
              aria-pressed={range === r.days}
              onClick={() => set('range', r.days === 30 ? null : String(r.days))}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {!view ? null : !view.hasAnything ? (
        <div className="empty">
          <h2>Nothing to show yet</h2>
          <p>Stats fill in as you add cards and study them.</p>
          <Link className="button primary" to="/">
            Go to decks
          </Link>
        </div>
      ) : (
        <div className="stats">
          <div className="tiles">
            <Tile label="Today" value={plural(view.today.n, 'review')} sub={view.today.ms ? minutes(view.today.ms) : 'nothing yet'} />
            <Tile
              label="Due today"
              value={plural(view.forecast[0].due, 'card')}
              sub={`${plural(view.weekDue, 'card')} this week`}
            />
            <Tile
              label={`Retention · ${RANGES.find((r) => r.days === range)!.label}`}
              value={rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}
              sub={
                rate === null ? (
                  'no review cards answered'
                ) : (
                  <>
                    {view.retention.passed} of {plural(view.retention.total, 'review')} · target{' '}
                    {Math.round(target * 100)}%
                  </>
                )
              }
            />
            <Tile
              label="Streak"
              value={plural(view.streak, 'day')}
              sub={`${view.activeDays} of ${range} days studied`}
            />
          </div>

          {drift ? (
            <div className="banner">
              <p>
                Your retention ({(rate! * 100).toFixed(0)}%) is{' '}
                {rate! < target ? 'below' : 'above'} the {Math.round(target * 100)}% you asked for. Fitting
                the scheduler to your own history usually closes that gap.
              </p>
              <Link className="button" to="/settings#scheduling">
                Optimize
              </Link>
            </div>
          ) : null}

          <section className="panel stats__card">
            <div className="stats__head">
              <h2>Reviews</h2>
              <span className="small faint">{plural(view.inRange, 'answer')} in the last {RANGES.find((r) => r.days === range)!.label}</span>
            </div>
            <BarChart
              series={HISTORY_SERIES}
              data={view.historyData}
              label={`Answers per ${view.weekly ? 'week' : 'day'} over the last ${range} days, split into review, learning and new`}
              unit={(n) => plural(n, 'answer')}
              period={view.weekly ? 'Week' : 'Day'}
            />
          </section>

          <section className="panel stats__card">
            <div className="stats__head">
              <h2>Due in the next {FORECAST_DAYS} days</h2>
              <span className="small faint">Learning and review cards; new cards come from the daily limit</span>
            </div>
            <BarChart
              series={FORECAST_SERIES}
              data={view.forecastData}
              label={`Cards due per day over the next ${FORECAST_DAYS} days`}
              unit={(n) => plural(n, 'card')}
            />
          </section>

          <section className="panel stats__card">
            <div className="stats__head">
              <h2>Cards</h2>
              <span className="small faint">{plural(view.counts.total, 'card')}</span>
            </div>
            <div className="tiles tiles--compact">
              <Tile label="New" value={view.counts.new.toLocaleString()} sub="not yet studied" />
              <Tile label="Learning" value={view.counts.learning.toLocaleString()} sub="in steps" />
              <Tile label="Young" value={view.counts.young.toLocaleString()} sub="interval under 21 days" />
              <Tile label="Mature" value={view.counts.mature.toLocaleString()} sub="21 days or more" />
              <Tile label="Suspended" value={view.counts.suspended.toLocaleString()} sub="out of rotation" />
            </div>
          </section>

          <p className="small faint stats__foot">
            Scheduling uses FSRS{fsrs?.w.length ? ' with weights fitted to your reviews' : ' with its default weights'}.{' '}
            <Link to="/settings#scheduling">Scheduling settings</Link>
          </p>
        </div>
      )}
    </>
  );
}
