import { useCallback, useState } from 'react';
import type { AlertKind, EventSummary, OperationsSummary, StoredScanOutcome } from '../../shared/types';
import { api, formatDateTime, formatTime } from '../api';
import { Badge, Bar, CapacityLine, EmptyState, ErrorNote, SectionHead, Stat, TableMessage, ToneBadge, errorMessage, type Tone } from '../ui';
import { LIVE_POLL_MS, usePolling } from './hooks';
import { ScanFeed } from './ScanFeed';

const ALERT_LABEL: Record<AlertKind, string> = {
  repeated_duplicate: 'Repeated duplicate',
  multi_gate: 'Multiple gates',
  invalid_burst: 'Invalid burst',
  capacity_near: 'Near capacity'
};

const POLICY_STATE: Record<OperationsSummary['policies'][number]['state'], { label: string; tone: Tone }> = {
  upcoming: { label: 'Upcoming', tone: 'info' },
  open: { label: 'Open', tone: 'ok' },
  full: { label: 'Full', tone: 'bad' },
  closed: { label: 'Closed', tone: 'muted' }
};

/** Live door picture: totals, gates, policy capacity, timeline and alerts, refreshed while visible. */
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
      <p className="muted small">
        <span className="live-dot" aria-hidden /> Refreshes every {LIVE_POLL_MS / 1000} s while this tab is open
        {summary ? ` · updated ${new Date(summary.generatedAt).toLocaleTimeString()}` : ''}
      </p>
      <ErrorNote message={error} />
      {summary ? <Summary summary={summary} /> : !error ? <p className="muted" role="status">Loading operations…</p> : null}
      <section className="card">
        <SectionHead title="Live scans" description="Newest first, from every device." />
        <ScanFeed token={token} event={event} onChanged={onChanged} />
      </section>
    </div>
  );
}

function Summary({ summary }: { summary: OperationsSummary }) {
  const { totals } = summary;
  return (
    <>
      <div className="stats">
        <Stat label="Scans" value={totals.scans} />
        <Stat label="Admitted" value={totals.admitted} tone="ok" />
        <Stat label="Denied" value={totals.denied} tone={totals.denied ? 'bad' : undefined} />
        <Stat label="Admit rate" value={totals.scans ? `${Math.round((totals.admitted / totals.scans) * 100)}%` : '—'} />
      </div>
      <Alerts alerts={summary.alerts} />
      <div className="grid-2">
        <Gates gates={summary.gates} />
        <Policies policies={summary.policies} />
      </div>
      <div className="grid-2">
        <Timeline buckets={summary.timeline} />
        <Outcomes outcomes={summary.outcomes} total={totals.scans} />
      </div>
    </>
  );
}

function Alerts({ alerts }: { alerts: OperationsSummary['alerts'] }) {
  return (
    <section className="card">
      <SectionHead title="Alerts" description="Patterns worth a look at the door." />
      {alerts.length === 0 ? (
        <p className="muted small">No alerts. Duplicate attempts, passes seen at several gates, bursts of invalid codes and nearly full policies appear here.</p>
      ) : (
        <ul className="alert-list">
          {alerts.map((alert, index) => (
            <li key={`${alert.kind}-${alert.passId ?? alert.scannerId ?? alert.policyId ?? index}`} className={`alert-item alert-${alert.severity}`}>
              <ToneBadge tone={alert.severity === 'warning' ? 'warn' : 'info'}>{alert.severity === 'warning' ? 'Warning' : 'Info'}</ToneBadge>
              <div>
                <div className="alert-title">{ALERT_LABEL[alert.kind]}</div>
                <div className="small">{alert.message}</div>
              </div>
              <div className="muted small alert-meta num">
                {alert.count}× · last {formatTime(alert.lastAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Gates({ gates }: { gates: OperationsSummary['gates'] }) {
  return (
    <section className="card">
      <SectionHead title="Admissions by gate" />
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
              <th scope="col">Last scan</th>
            </tr>
          </thead>
          <tbody>
            {gates.map((gate) => (
              <tr key={gate.id ?? 'any'}>
                <td>{gate.id ? gate.name : <span className="muted">{gate.name || 'Any gate'}</span>}</td>
                <td className="num">{gate.admitted}</td>
                <td className="num">{gate.denied}</td>
                <td className="small">{gate.lastScanAt ? formatTime(gate.lastScanAt) : '—'}</td>
              </tr>
            ))}
            {gates.length === 0 ? <TableMessage colSpan={4}>No scans yet. Add gates and scanner devices on the Access tab.</TableMessage> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Policies({ policies }: { policies: OperationsSummary['policies'] }) {
  return (
    <section className="card">
      <SectionHead title="Policy capacity" />
      {policies.length === 0 ? (
        <EmptyState title="No admission policies">Passes without a policy can enter at any gate during the event. Create policies on the Access tab.</EmptyState>
      ) : (
        <ul className="capacity-list">
          {policies.map((policy) => {
            const state = POLICY_STATE[policy.state];
            return (
              <li key={policy.id}>
                <div className="capacity-head">
                  <span className="capacity-name">{policy.name}</span>
                  <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
                </div>
                <CapacityLine admitted={policy.admitted} capacity={policy.capacity} />
                <div className="muted small">
                  {formatDateTime(policy.opensAt)} – {formatDateTime(policy.closesAt)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Timeline({ buckets }: { buckets: OperationsSummary['timeline'] }) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.admitted + bucket.denied));
  const busiest = buckets.find((bucket) => bucket.admitted + bucket.denied === peak);
  return (
    <section className="card">
      <SectionHead title="Scans per 15 minutes" />
      {buckets.length === 0 ? (
        <p className="muted small">No scans yet.</p>
      ) : (
        <>
          <div
            className="timeline"
            role="img"
            aria-label={`Scans per 15 minutes from ${formatTime(buckets[0].bucketStart)} to ${formatTime(buckets[buckets.length - 1].bucketStart)}.${busiest ? ` Busiest: ${peak} scans at ${formatTime(busiest.bucketStart)}.` : ''}`}
          >
            {buckets.map((bucket) => (
              <div key={bucket.bucketStart} className="timeline-col" title={`${formatTime(bucket.bucketStart)}: ${bucket.admitted} admitted, ${bucket.denied} denied`}>
                <span className="timeline-denied" style={{ height: `${(bucket.denied / peak) * 100}%` }} />
                <span className="timeline-admitted" style={{ height: `${(bucket.admitted / peak) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="timeline-axis muted small">
            <span>{formatTime(buckets[0].bucketStart)}</span>
            <span className="legend">
              <span className="legend-swatch legend-admitted" aria-hidden /> Admitted <span className="legend-swatch legend-denied" aria-hidden /> Denied
            </span>
            <span>{formatTime(buckets[buckets.length - 1].bucketStart)}</span>
          </div>
        </>
      )}
    </section>
  );
}

function Outcomes({ outcomes, total }: { outcomes: OperationsSummary['outcomes']; total: number }) {
  const rows = (Object.entries(outcomes) as Array<[StoredScanOutcome, number]>).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  return (
    <section className="card">
      <SectionHead title="Outcomes" />
      {rows.length === 0 ? (
        <p className="muted small">No scans yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Result</th>
              <th scope="col" className="num">
                Scans
              </th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([outcome, count]) => (
              <tr key={outcome}>
                <td>
                  <Badge value={outcome} />
                </td>
                <td className="num">{count}</td>
                <td className="share-cell">
                  <Bar value={count} max={total} tone={outcome === 'admitted' ? 'ok' : 'muted'} />
                  <span className="small num">{total ? Math.round((count / total) * 100) : 0}%</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
