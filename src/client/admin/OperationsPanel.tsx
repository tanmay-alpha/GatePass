import { Info, TriangleAlert } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { AlertKind, EventSummary, OperationsSummary, StoredScanOutcome } from '../../shared/types';
import { api, formatTime } from '../api';
import { Bar, EmptyState, ErrorNote, OutcomeBadge, SectionHead, Stat, TableMessage, ToneBadge, capacityTone, errorMessage, type Tone } from '../ui';
import { LIVE_POLL_MS, usePolling } from './hooks';
import { ScanFeed } from './ScanFeed';

const ALERT_LABEL: Record<AlertKind, string> = {
  repeated_duplicate: 'Repeated duplicate',
  multi_gate: 'Multiple gates',
  invalid_burst: 'Invalid burst',
  capacity_near: 'Near capacity'
};

type PolicyState = OperationsSummary['policies'][number]['state'];

const POLICY_STATE: Record<PolicyState, { label: string; tone: Tone }> = {
  upcoming: { label: 'Upcoming', tone: 'info' },
  open: { label: 'Open', tone: 'ok' },
  full: { label: 'Full', tone: 'bad' },
  closed: { label: 'Closed', tone: 'muted' }
};

/** Live door picture: totals, alerts, timeline, gates, policy capacity and the scan feed, refreshed while visible. */
export function OperationsPanel({ token, event, onChanged }: { token: string; event: EventSummary; onChanged: () => Promise<void> }) {
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [error, setError] = useState('');

  const poll = useCallback(async () => {
    try {
      setSummary(await api<OperationsSummary>(`/api/events/${event.id}/operations`, token));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [event.id, token]);

  usePolling(poll, LIVE_POLL_MS);

  return (
    <div className="stack-lg">
      <ErrorNote message={error} />
      {summary ? <Summary summary={summary} /> : !error ? <p className="muted" role="status">Loading operations…</p> : null}
      <section className="card" aria-labelledby="feed-title">
        <SectionHead id="feed-title" title="Live scan feed" description="Newest first, from every device.">
          <span className="card-meta" title={`Refreshes every ${LIVE_POLL_MS / 1000} s while this tab is open`}>
            <span className="live-dot" aria-hidden /> Live
            {summary ? <span className="num"> · updated {new Date(summary.generatedAt).toLocaleTimeString()}</span> : null}
          </span>
        </SectionHead>
        <ScanFeed token={token} event={event} onChanged={onChanged} />
      </section>
    </div>
  );
}

function Summary({ summary }: { summary: OperationsSummary }) {
  const { totals } = summary;
  return (
    <>
      <div className="stats stats-lg">
        <Stat label="Scans" value={totals.scans} />
        <Stat label="Admitted" value={totals.admitted} />
        <Stat label="Denied" value={totals.denied} />
        <Stat label="Admit rate" value={totals.scans ? `${((totals.admitted / totals.scans) * 100).toFixed(1)}%` : '—'} />
      </div>
      <div className="ops-grid">
        <Alerts alerts={summary.alerts} />
        <Timeline buckets={summary.timeline} outcomes={summary.outcomes} total={totals.scans} />
      </div>
      <div className="ops-grid">
        <Gates gates={summary.gates} />
        <Policies policies={summary.policies} />
      </div>
    </>
  );
}

function Alerts({ alerts }: { alerts: OperationsSummary['alerts'] }) {
  return (
    <section className="card" aria-labelledby="alerts-title">
      <SectionHead id="alerts-title" title="Alerts">
        <span className="card-meta num">{alerts.length} open</span>
      </SectionHead>
      {alerts.length === 0 ? (
        <p className="muted small">No alerts. Duplicate attempts, passes seen at several gates, bursts of invalid codes and nearly full policies appear here.</p>
      ) : (
        <ul className="alert-list">
          {alerts.map((alert, index) => {
            const warning = alert.severity === 'warning';
            const Icon = warning ? TriangleAlert : Info;
            return (
              <li key={`${alert.kind}-${alert.passId ?? alert.scannerId ?? alert.policyId ?? index}`} className={`alert-item alert-${alert.severity}`}>
                <Icon className="alert-icon" size={16} aria-hidden />
                <div className="alert-body">
                  <div className="alert-title">
                    <span>{ALERT_LABEL[alert.kind]}</span>
                    <ToneBadge tone={warning ? 'warn' : 'muted'}>{warning ? 'Warning' : 'Info'}</ToneBadge>
                  </div>
                  <div className="alert-message">{alert.message}</div>
                </div>
                <time className="alert-time num" dateTime={alert.lastAt}>
                  {formatTime(alert.lastAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Stacked bars (admitted below, denied on top) scaled to the busiest bucket, with the outcome breakdown underneath. */
function Timeline({ buckets, outcomes, total }: { buckets: OperationsSummary['timeline']; outcomes: OperationsSummary['outcomes']; total: number }) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.admitted + bucket.denied));
  const busiest = buckets.find((bucket) => bucket.admitted + bucket.denied === peak);
  const ticks = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])].filter((index) => index >= 0);
  return (
    <section className="card" aria-labelledby="timeline-title">
      <SectionHead id="timeline-title" title="Scans per 15 min">
        <span className="legend" aria-hidden>
          <span className="legend-item">
            <span className="legend-dot legend-admitted" /> Admitted
          </span>
          <span className="legend-item">
            <span className="legend-dot legend-denied" /> Denied
          </span>
        </span>
      </SectionHead>
      {buckets.length === 0 ? (
        <p className="muted small">No scans yet.</p>
      ) : (
        <div className="chart-wrap">
          <div
            className="chart"
            role="img"
            aria-label={`Scans per 15 minutes from ${formatTime(buckets[0].bucketStart)} to ${formatTime(buckets[buckets.length - 1].bucketStart)}.${busiest ? ` Busiest: ${peak} scans at ${formatTime(busiest.bucketStart)}.` : ''}`}
          >
            {buckets.map((bucket) => {
              const scans = bucket.admitted + bucket.denied;
              return (
                <div key={bucket.bucketStart} className="chart-col" title={`${formatTime(bucket.bucketStart)}: ${bucket.admitted} admitted, ${bucket.denied} denied`}>
                  {scans > 0 ? (
                    <div className="chart-bar" style={{ height: `${(scans / peak) * 100}%` }}>
                      {bucket.denied > 0 ? <span className="chart-denied" style={{ flexGrow: bucket.denied }} /> : null}
                      {bucket.admitted > 0 ? <span className="chart-admitted" style={{ flexGrow: bucket.admitted }} /> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="chart-axis num" aria-hidden>
            {ticks.map((index) => (
              <span key={index}>{formatTime(buckets[index].bucketStart)}</span>
            ))}
          </div>
        </div>
      )}
      <Outcomes outcomes={outcomes} total={total} />
    </section>
  );
}

function Outcomes({ outcomes, total }: { outcomes: OperationsSummary['outcomes']; total: number }) {
  const rows = (Object.entries(outcomes) as Array<[StoredScanOutcome, number]>).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;
  return (
    <div className="outcomes">
      <h3 className="label">Outcomes</h3>
      <ul className="outcome-list">
        {rows.map(([outcome, count]) => (
          <li key={outcome}>
            <span className="outcome-name">
              <OutcomeBadge outcome={outcome} />
            </span>
            <Bar value={count} max={total} tone={outcome === 'admitted' ? 'ok' : 'muted'} />
            <span className="muted num outcome-share">{total ? Math.round((count / total) * 100) : 0}%</span>
            <span className="num outcome-count">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gates({ gates }: { gates: OperationsSummary['gates'] }) {
  return (
    <section className="card" aria-labelledby="gates-ops-title">
      <SectionHead id="gates-ops-title" title="Admissions by gate" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Gate</th>
              <th scope="col" className="num">
                Admitted
              </th>
              <th scope="col" className="num">
                Denied
              </th>
              <th scope="col" className="num">
                Last scan
              </th>
            </tr>
          </thead>
          <tbody>
            {gates.map((gate) => (
              <tr key={gate.id ?? 'any'}>
                <td className="strong">{gate.id ? gate.name : <span className="muted">{gate.name || 'Any gate'}</span>}</td>
                <td className="num">{gate.admitted}</td>
                <td className="num">{gate.denied}</td>
                <td className="num muted">{gate.lastScanAt ? formatTime(gate.lastScanAt) : '—'}</td>
              </tr>
            ))}
            {gates.length === 0 ? <TableMessage colSpan={4}>No scans yet. Add gates and scanner devices on the Access tab.</TableMessage> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Bar colour follows the state; an open policy turns amber from 90 %. */
function policyBarTone(state: PolicyState, admitted: number, capacity: number): Tone {
  if (state === 'closed') return 'muted';
  if (state === 'full') return 'bad';
  return capacityTone(admitted, capacity);
}

function Policies({ policies }: { policies: OperationsSummary['policies'] }) {
  return (
    <section className="card" aria-labelledby="capacity-title">
      <SectionHead id="capacity-title" title="Policy capacity" />
      {policies.length === 0 ? (
        <EmptyState title="No admission policies">Passes without a policy can enter at any gate during the event. Create policies on the Access tab.</EmptyState>
      ) : (
        <ul className="capacity-list">
          {policies.map((policy) => {
            const state = POLICY_STATE[policy.state];
            return (
              <li key={policy.id}>
                <div className="capacity-head">
                  <div className="capacity-title">
                    <span className="capacity-name">{policy.name}</span>
                    <span className="muted small num">
                      {formatTime(policy.opensAt)} – {formatTime(policy.closesAt)}
                    </span>
                  </div>
                  <span className="muted num">{policy.capacity === null ? `${policy.admitted} admitted` : `${policy.admitted}/${policy.capacity}`}</span>
                  <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
                </div>
                {policy.capacity === null ? null : <Bar value={policy.admitted} max={policy.capacity} tone={policyBarTone(policy.state, policy.admitted, policy.capacity)} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
