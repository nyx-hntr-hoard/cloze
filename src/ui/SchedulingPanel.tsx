/**
 * Scheduling settings: desired retention, and the FSRS optimizer.
 *
 * The optimizer flow is deliberately two-step — fit, then look, then apply.
 * Fitting changes nothing; the result shows how the current and the fitted
 * weights score on cards held out of training, and only offers "Apply" when
 * the fitted ones are actually better there. Applying saves the weights and
 * recomputes each card's memory estimate from its history; it never moves a
 * due date.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { applyWeights, getFsrsParams, loadTrainingData, updateFsrsParams } from '../repo';
import { MIN_PREDICTIONS, OptimizationCancelled, trainAndCompare, type OptimizationReport } from '../optimizer';
import { formatDate } from '../lib/time';
import { plural } from '../lib/text';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: number; reviews: number }
  | { kind: 'thin'; reviews: number; skipped: number }
  | { kind: 'done'; report: OptimizationReport; skipped: number }
  | { kind: 'applied'; message: string }
  | { kind: 'error'; message: string };

export function SchedulingPanel() {
  const params = useLiveQuery(() => getFsrsParams(), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const { hash } = useLocation();
  const panel = useRef<HTMLDivElement>(null);

  // Leaving the page stops a fit in progress rather than letting it run unseen.
  useEffect(() => () => abort.current?.abort(), []);

  // `#/settings#scheduling` (linked from Stats) lands here. The browser can't
  // do it itself: this panel doesn't exist until its parameters have loaded.
  const loaded = !!params;
  useEffect(() => {
    if (loaded && hash === '#scheduling') panel.current?.scrollIntoView({ block: 'start' });
  }, [loaded, hash]);

  if (!params) return null;
  const custom = params.w.length > 0;

  async function run() {
    // Created before anything is awaited, so Cancel works from the first
    // frame — including while the review log is still being read.
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: 'running', progress: 0, reviews: 0 });
    try {
      const { data, params: current, config } = await loadTrainingData();
      if (controller.signal.aborted) throw new OptimizationCancelled();
      if (data.predictions < MIN_PREDICTIONS) {
        setPhase({ kind: 'thin', reviews: data.predictions, skipped: data.skippedCards });
        return;
      }
      setPhase({ kind: 'running', progress: 0, reviews: data.predictions });
      const report = await trainAndCompare(data, current.w, config, {
        signal: controller.signal,
        onProgress: (progress) => setPhase({ kind: 'running', progress, reviews: data.predictions }),
      });
      setPhase({ kind: 'done', report, skipped: data.skippedCards });
    } catch (e) {
      if (e instanceof OptimizationCancelled) setPhase({ kind: 'idle' });
      else setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }

  async function apply(weights: number[]) {
    setBusy(true);
    try {
      const { recomputed, kept } = await applyWeights(weights, Date.now());
      setPhase({
        kind: 'applied',
        message:
          `${weights.length ? 'Applied the fitted weights.' : 'Back to the default weights.'} ` +
          `Recomputed the memory estimate of ${plural(recomputed, 'card')} from ${recomputed === 1 ? 'its' : 'their'} history` +
          (kept ? `; ${plural(kept, 'card')} without a complete history kept ${kept === 1 ? 'its' : 'theirs'}` : '') +
          '. No due dates changed.',
      });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const retentionPct = Math.round(params.requestRetention * 100);
  const fmt = (n: number, digits: number) => n.toFixed(digits);

  return (
    <div className="panel" id="scheduling" ref={panel}>
      <h2 className="panel__title">Scheduling</h2>

      <div className="setting">
        <div>
          <div className="setting__label">Desired retention</div>
          <div className="setting__hint">
            How often you want to remember a card when it comes due. Higher means shorter intervals and
            more reviews — going from 90% to 95% roughly doubles the workload.
          </div>
        </div>
        <div className="setting__control retention">
          <input
            id="retention"
            type="range"
            min={70}
            max={97}
            step={1}
            value={retentionPct}
            aria-label="Desired retention"
            aria-valuetext={`${retentionPct}%`}
            onChange={(e) => void updateFsrsParams({ requestRetention: Number(e.target.value) / 100 })}
          />
          <output htmlFor="retention" className="retention__value">
            {retentionPct}%
          </output>
        </div>
      </div>

      <div className="setting setting--stack">
        <div>
          <div className="setting__label">Fit to your reviews</div>
          <div className="setting__hint">
            {custom
              ? `Using weights fitted to your history${params.optimizedAt ? ` on ${formatDate(params.optimizedAt)}` : ''}.`
              : 'Using the FSRS default weights, which fit an average learner.'}{' '}
            The optimizer learns how quickly <em>you</em> forget from your review log. It needs at least{' '}
            {MIN_PREDICTIONS} reviews that came a day or more after the previous one, and gets better with more.
          </div>
        </div>

        <div className="optimizer">
          {phase.kind === 'running' ? (
            <div className="optimizer__running">
              <div className="small">
                Fitting to {phase.reviews ? plural(phase.reviews, 'review') : 'your reviews'}…{' '}
                {Math.round(phase.progress * 100)}%
              </div>
              <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(phase.progress * 100)}>
                <div className="meter__fill" style={{ width: `${phase.progress * 100}%` }} />
              </div>
              <button className="ghost" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row">
              <button className="primary" onClick={() => void run()} disabled={busy}>
                {phase.kind === 'done' ? 'Run again' : 'Optimize'}
              </button>
              {custom ? (
                <button onClick={() => void apply([])} disabled={busy}>
                  Reset to defaults
                </button>
              ) : null}
            </div>
          )}

          {phase.kind === 'thin' ? (
            <p className="small muted">
              Not enough history yet: {plural(phase.reviews, 'usable review')} so far, and {MIN_PREDICTIONS} are
              needed for a fit you can trust. Keep studying and try again.
              {phase.skipped ? ` (${plural(phase.skipped, 'card')} with incomplete history can't be used.)` : ''}
            </p>
          ) : null}

          {phase.kind === 'error' ? <p className="field-error">{phase.message}</p> : null}
          {phase.kind === 'applied' ? (
            <p className="small optimizer__ok" role="status">
              {phase.message}
            </p>
          ) : null}

          {phase.kind === 'done' ? (
            <div className="optimizer__result">
              <table className="optimizer__table">
                <thead>
                  <tr>
                    <th />
                    <th>{custom ? 'Current' : 'Defaults'}</th>
                    <th>Fitted</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Log loss</th>
                    <td>{fmt(phase.report.current.logLoss, 4)}</td>
                    <td>{fmt(phase.report.trained.logLoss, 4)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Calibration error</th>
                    <td>{fmt(phase.report.current.rmse, 1)}%</td>
                    <td>{fmt(phase.report.trained.rmse, 1)}%</td>
                  </tr>
                </tbody>
              </table>
              <p className="small faint">
                Lower is better for both. Scored on {plural(phase.report.testCards, 'card')} (
                {plural(phase.report.current.n, 'review')}) held out of training, so the comparison is fair;
                trained on the other {plural(phase.report.trainCards, 'card')}.
                {phase.skipped ? ` ${plural(phase.skipped, 'card')} with incomplete history were left out.` : ''}
              </p>
              {phase.report.better ? (
                <>
                  <p className="small">
                    The fitted weights predict your recall better than the {custom ? 'current ones' : 'defaults'}.
                  </p>
                  <div className="row">
                    <button className="primary" disabled={busy} onClick={() => void apply(phase.report.weights)}>
                      {busy ? 'Applying…' : 'Apply fitted weights'}
                    </button>
                    <button className="ghost" onClick={() => setPhase({ kind: 'idle' })}>
                      Discard
                    </button>
                  </div>
                </>
              ) : (
                <p className="small">
                  The {custom ? 'current weights' : 'defaults'} already fit your history at least as well — nothing to
                  change.
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
