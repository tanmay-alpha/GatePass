import { Download, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AlertKind, EventSummary, OperationsCompletion, OperationsSummary, StoredScanOutcome } from '../../shared/types';
import { Bar, EmptyState, ErrorNote, OUTCOME_LABEL, OutcomeBadge, SectionHead, Stat, TableMessage, ToneBadge, capacityTone, errorMessage, type Tone } from '../ui';
import { formatTimeInZone, zoneLabel } from '../time';
import { LIVE_POLL_MS, usePolling } from './hooks';
import { adminApi, adminDownload } from './http';
import { can } from './model';
import { ScanFeed } from './ScanFeed';
import './operations.css';

const ALERT_LABEL: Record<AlertKind, string> = {
  repeated_duplicate: 'Repeated duplicate',
  multi_gate: 'Multiple gates',
  invalid_burst: 'Invalid burst',
  capacity_near: 'Near capacity',
  device_idle: 'Device silent'
};

const PHASE: Record<OperationsSummary['phase'], { label: string; tone: Tone }> = {
  upcoming: { label: 'Doors not open yet', tone: 'info' },
  live: { label: 'Doors open', tone: 'ok' },
  paused: { label: 'Draft: scanners refuse entry', tone: 'warn' },
  finished: { label: 'Finished', tone: 'muted' }
};

/** Data older than three missed polls is flagged as stale. */
const STALE_AFTER_MS = 3 * LIVE_POLL_MS;

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

type PolicyState = OperationsSummary['policies'][number]['state'];

const POLICY_STATE: Record<PolicyState, { label: string; tone: Tone }> = {
  upcoming: { label: 'Upcoming', tone: 'info' },
  open: { label: 'Open', tone: 'ok' },
  full: { label: 'Full', tone: 'bad' },
  closed: { label: 'Closed', tone: 'muted' }
};

type ScannerState = OperationsSummary['scanners'][number]['state'];

const SCANNER_STATE: Record<ScannerState, { label: string; tone: Tone }> = {
  recent: { label: 'Recent', tone: 'ok' },
  idle: { label: 'Idle', tone: 'warn' },
  never_used: { label: 'Never used', tone: 'muted' },
  revoked: { label: 'Revoked', tone: 'bad' }
};

/** Live door picture: turnout, capacity, devices, alerts, activity, gates, policies and the scan feed, refreshed while visible. */
export function OperationsPanel({ event, onChanged }: { event: EventSummary; onChanged: () => Promise<void> }) {
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const poll = useCallback(async () => {
    setRefreshing(true);
    try {
      setSummary(await adminApi<OperationsSummary>(`/api/events/${event.id}/operations`));
      setUpdatedAt(Date.now());
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [event.id]);

  usePolling(poll, LIVE_POLL_MS);
  // A clock for the stale check, so a stalled poll is noticed even though nothing new arrives.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, []);
  const stale = updatedAt !== null && now - updatedAt > STALE_AFTER_MS;

  return (
    <div className="stack-lg">
      {can(event, 'export') ? <Exports event={event} /> : null}
      <RefreshBar summary={summary} error={error} stale={stale} refreshing={refreshing} zone={event.timeZone} onRefresh={() => void poll()} />
      {summary ? (
        <Summary summary={summary} zone={event.timeZone} />
      ) : !error ? (
        <p className="muted" role="status">
          Loading operations…
        </p>
      ) : null}
      <section className="card" aria-labelledby="feed-title">
        <SectionHead id="feed-title" title="Live scan feed" description="Newest first, from every device.">
          <span className="card-meta" title={`Refreshes every ${LIVE_POLL_MS / 1000} s while this tab is open`}>
            <span className="live-dot" aria-hidden /> Live
          </span>
        </SectionHead>
        <ScanFeed event={event} onChanged={onChanged} />
      </section>
    </div>
  );
}

interface RefreshBarProps {
  summary: OperationsSummary | null;
  error: string;
  stale: boolean;
  refreshing: boolean;
  zone: string;
  onRefresh: () => void;
}

/** Door phase, when the numbers were taken, and what to do when refreshing fails: the last good data stays on screen. */
function RefreshBar({ summary, error, stale, refreshing, zone, onRefresh }: RefreshBarProps) {
  const phase = summary ? PHASE[summary.phase] : null;
  const asOf = summary ? new Date(summary.generatedAt).toLocaleTimeString(undefined, { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
  const problem = error ? (summary ? `Could not refresh: ${error} Showing data from ${asOf}.` : error) : stale ? `No fresh data since ${asOf}.` : '';
  return (
    <div className={`ops-status${problem ? ' ops-status-problem' : ''}`}>
      {phase ? <ToneBadge tone={phase.tone}>{phase.label}</ToneBadge> : null}
      {summary && asOf ? (
        <span className="small muted num">
          Updated <time dateTime={summary.generatedAt}>{asOf}</time> · every {LIVE_POLL_MS / 1000} s
        </span>
      ) : null}
      {stale || (error && summary) ? <ToneBadge tone="warn">Stale</ToneBadge> : null}
      <span className="ops-status-message small" role="status">
        {problem}
      </span>
      <button type="button" className="btn btn-secondary btn-small" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw size={14} aria-hidden className={refreshing ? 'spin' : undefined} /> {refreshing ? 'Refreshing…' : error ? 'Retry now' : 'Refresh'}
      </button>
    </div>
  );
}

function Exports({ event }: { event: EventSummary }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function run(kind: 'attendance' | 'scans' | 'audit') {
    setBusy(kind);
    setError('');
    try {
      await adminDownload(`/api/events/${event.id}/exports/${kind}.csv`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack-sm">
      <div className="actions exports" role="group" aria-label="Exports">
        <span className="muted small">Export CSV:</span>
        {(
          [
            ['attendance', 'Attendance'],
            ['scans', 'Scans'],
            ['audit', 'Audit log']
          ] as const
        ).map(([kind, label]) => (
          <button key={kind} type="button" className="btn btn-secondary btn-small" onClick={() => void run(kind)} disabled={busy !== null}>
            <Download size={14} aria-hidden /> {busy === kind ? 'Exporting…' : `${label} CSV`}
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
    </div>
  );
}

function Summary({ summary, zone }: { summary: OperationsSummary; zone: string }) {
  const { totals, passes, capacity, attendance } = summary;
  return (
    <>
      {summary.completion ? <Completion completion={summary.completion} zone={zone} /> : null}
      <div className="stats stats-lg">
        <Stat label="Admitted / issued" value={`${passes.redeemed} / ${passes.issued}`} />
        <Stat label="Turnout of expected" value={attendance.rate === null ? '—' : `${percent(attendance.rate)} of ${attendance.expected}`} />
        <Stat label="Capacity used" value={capacity.limit === null ? 'No limit' : percent(capacity.admitted / capacity.limit)} />
        <Stat label="Denied scans" value={totals.denied} />
        <Stat label="Assisted admissions" value={summary.assistedAdmissions} />
      </div>
      <div className="ops-grid">
        <PassStates passes={passes} capacity={capacity} expected={attendance.expected} />
        <Scanners scanners={summary.scanners} zone={zone} />
      </div>
      <div className="ops-grid">
        <Alerts alerts={summary.alerts} zone={zone} />
        <Recent recent={summary.recent} zone={zone} />
      </div>
      <div className="ops-grid">
        <Timeline buckets={summary.timeline} outcomes={summary.outcomes} zone={zone} />
        <Gates gates={summary.gates} zone={zone} />
      </div>
      <Policies policies={summary.policies} zone={zone} />
    </>
  );
}

/** Wrap-up once the doors have closed: who came, when, and what went wrong at the door. */
function Completion({ completion, zone }: { completion: OperationsCompletion; zone: string }) {
  const time = (iso: string | null) => (iso ? formatTimeInZone(iso, zone) : '—');
  return (
    <section className="card ops-completion" aria-labelledby="completion-title">
      <SectionHead id="completion-title" title="Event summary" description="The doors are closed. Final figures from the scan log." />
      <dl className="ops-facts">
        <div>
          <dt>Attended</dt>
          <dd className="num">
            {completion.admitted} of {completion.expected} expected{completion.rate === null ? '' : ` (${percent(completion.rate)})`}
          </dd>
        </div>
        <div>
          <dt>No-shows</dt>
          <dd className="num">{completion.noShows}</dd>
        </div>
        <div>
          <dt>Admissions</dt>
          <dd className="num">
            {completion.firstAdmissionAt ? `${time(completion.firstAdmissionAt)} – ${time(completion.lastAdmissionAt)}` : 'None'}
          </dd>
        </div>
        <div>
          <dt>Busiest 5 min</dt>
          <dd className="num">{completion.peak ? `${completion.peak.admitted} admitted from ${time(completion.peak.bucketStart)}` : '—'}</dd>
        </div>
        <div>
          <dt>Denied scans</dt>
          <dd className="num">
            {completion.denied}
            {completion.topDenial ? ` · mostly ${OUTCOME_LABEL[completion.topDenial.outcome].toLowerCase()} (${completion.topDenial.count})` : ''}
          </dd>
        </div>
        <div>
          <dt>Used at the door</dt>
          <dd className="num">
            {completion.devicesUsed} device{completion.devicesUsed === 1 ? '' : 's'} · {completion.gatesUsed} gate{completion.gatesUsed === 1 ? '' : 's'}
          </dd>
        </div>
      </dl>
    </section>
  );
}

const PASS_ROWS: Array<{ key: 'active' | 'redeemed' | 'revoked' | 'expired'; label: string; tone: Tone; note: string }> = [
  { key: 'active', label: 'Active', tone: 'info', note: 'valid, not used yet' },
  { key: 'redeemed', label: 'Redeemed', tone: 'ok', note: 'admitted' },
  { key: 'revoked', label: 'Revoked', tone: 'bad', note: 'cancelled by an organizer' },
  { key: 'expired', label: 'Expired', tone: 'muted', note: 'unused past expiry' }
];

function PassStates({ passes, capacity, expected }: { passes: OperationsSummary['passes']; capacity: OperationsSummary['capacity']; expected: number }) {
  return (
    <section className="card" aria-labelledby="pass-states-title">
      <SectionHead id="pass-states-title" title="Passes">
        <span className="card-meta num" title="Expected at the door: issued passes that were not revoked before entry">
          {passes.issued} issued · {expected} expected
        </span>
      </SectionHead>
      {passes.issued === 0 ? (
        <p className="muted small">No passes issued yet.</p>
      ) : (
        <ul className="outcome-list">
          {PASS_ROWS.map((row) => (
            <li key={row.key}>
              <span className="outcome-name">
                <ToneBadge tone={row.tone}>{row.label}</ToneBadge>
              </span>
              <Bar value={passes[row.key]} max={passes.issued} tone={row.tone} />
              <span className="muted num outcome-share">{Math.round((passes[row.key] / passes.issued) * 100)}%</span>
              <span className="num outcome-count" title={row.note}>
                {passes[row.key]}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="outcomes">
        <h3 className="label">Event capacity</h3>
        {capacity.limit === null ? (
          <p className="small muted num">{capacity.admitted} admitted · no event-wide limit (set one in Settings)</p>
        ) : (
          <div className="capacity-line">
            <Bar value={capacity.admitted} max={capacity.limit} tone={capacityTone(capacity.admitted, capacity.limit)} />
            <span className="small num">
              {capacity.admitted}/{capacity.limit} admitted · {capacity.remaining} left
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function Scanners({ scanners, zone }: { scanners: OperationsSummary['scanners']; zone: string }) {
  return (
    <section className="card" aria-labelledby="scanner-health-title">
      <SectionHead id="scanner-health-title" title="Scanner devices">
        <span className="card-meta">Idle = no request for 10 min; silent devices raise an alert while the doors are open</span>
      </SectionHead>
      {scanners.length === 0 ? (
        <p className="muted small">No devices yet. Add one on the Access tab.</p>
      ) : (
        <ul className="health-list">
          {scanners.map((scanner) => {
            const state = SCANNER_STATE[scanner.state];
            return (
              <li key={scanner.id}>
                <div className="health-main">
                  <span className="strong">{scanner.label}</span>
                  <span className="muted small">
                    {scanner.gateName ?? 'Any gate'} · {scanner.lastUsedAt ? `last seen ${formatTimeInZone(scanner.lastUsedAt, zone)}` : 'never seen'}
                    {scanner.scansLast15m ? ` · ${scanner.scansLast15m} scans in 15 min` : ''}
                  </span>
                </div>
                <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Alerts({ alerts, zone }: { alerts: OperationsSummary['alerts']; zone: string }) {
  return (
    <section className={`card${alerts.length === 0 ? ' ops-alerts-empty' : ''}`} aria-labelledby="alerts-title">
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
                  {formatTimeInZone(alert.lastAt, zone)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ChartLegend() {
  return (
    <span className="legend" aria-hidden>
      <span className="legend-item">
        <span className="legend-dot legend-admitted" /> Admitted
      </span>
      <span className="legend-item">
        <span className="legend-dot legend-denied" /> Denied
      </span>
    </span>
  );
}

/** Stacked bars (admitted below, denied on top) scaled to the busiest bucket. */
function BucketChart({ buckets, minutes, zone }: { buckets: OperationsSummary['timeline']; minutes: number; zone: string }) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.admitted + bucket.denied));
  const busiest = buckets.find((bucket) => bucket.admitted + bucket.denied === peak);
  const ticks = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])].filter((index) => index >= 0);
  const time = (iso: string) => formatTimeInZone(iso, zone);
  return (
    <div className="chart-wrap">
      <div
        className="chart"
        role="img"
        aria-label={`Scans per ${minutes} minutes from ${time(buckets[0].bucketStart)} to ${time(buckets[buckets.length - 1].bucketStart)}.${busiest ? ` Busiest: ${peak} scans at ${time(busiest.bucketStart)}.` : ''}`}
      >
        {buckets.map((bucket) => {
          const scans = bucket.admitted + bucket.denied;
          return (
            <div key={bucket.bucketStart} className="chart-col" title={`${time(bucket.bucketStart)}: ${bucket.admitted} admitted, ${bucket.denied} denied`}>
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
          <span key={index}>{time(buckets[index].bucketStart)}</span>
        ))}
      </div>
    </div>
  );
}

/** The whole event in 15-minute buckets, with the denial reasons underneath. */
function Timeline({ buckets, outcomes, zone }: { buckets: OperationsSummary['timeline']; outcomes: OperationsSummary['outcomes']; zone: string }) {
  return (
    <section className="card" aria-labelledby="timeline-title">
      <SectionHead id="timeline-title" title={`Scans per 15 min (${buckets.length ? zoneLabel(zone, buckets[0].bucketStart) : zone})`}>
        <ChartLegend />
      </SectionHead>
      {buckets.length === 0 ? <p className="muted small">No scans yet.</p> : <BucketChart buckets={buckets} minutes={15} zone={zone} />}
      <Outcomes outcomes={outcomes} />
    </section>
  );
}

/** Admission pace right now: the last hour, so a stalled door or a sudden queue shows at a glance. */
function Recent({ recent, zone }: { recent: OperationsSummary['recent']; zone: string }) {
  const admitted = recent.buckets.reduce((sum, bucket) => sum + bucket.admitted, 0);
  const denied = recent.buckets.reduce((sum, bucket) => sum + bucket.denied, 0);
  const current = recent.buckets.at(-1);
  return (
    <section className="card" aria-labelledby="recent-title">
      <SectionHead id="recent-title" title={`Last hour, per ${recent.bucketMinutes} min`}>
        <ChartLegend />
      </SectionHead>
      <p className="small num ops-recent-totals">
        <span className="strong">{admitted}</span> admitted · <span className="strong">{denied}</span> denied
        {current ? (
          <span className="muted">
            {' '}
            · {current.admitted} admitted since {formatTimeInZone(current.bucketStart, zone)}
          </span>
        ) : null}
      </p>
      {admitted + denied === 0 ? <p className="muted small">No scans in the last hour.</p> : <BucketChart buckets={recent.buckets} minutes={recent.bucketMinutes} zone={zone} />}
    </section>
  );
}

/** Why people were turned away, as a share of all denied scans. */
function Outcomes({ outcomes }: { outcomes: OperationsSummary['outcomes'] }) {
  const rows = (Object.entries(outcomes) as Array<[StoredScanOutcome, number]>).filter(([outcome, count]) => outcome !== 'admitted' && count > 0).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;
  const denied = rows.reduce((sum, [, count]) => sum + count, 0);
  return (
    <div className="outcomes">
      <h3 className="label">Denial reasons</h3>
      <ul className="outcome-list">
        {rows.map(([outcome, count]) => (
          <li key={outcome}>
            <span className="outcome-name">
              <OutcomeBadge outcome={outcome} />
            </span>
            <Bar value={count} max={denied} tone="muted" />
            <span className="muted num outcome-share">{percent(count / denied)}</span>
            <span className="num outcome-count">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gates({ gates, zone }: { gates: OperationsSummary['gates']; zone: string }) {
  const admitted = gates.reduce((sum, gate) => sum + gate.admitted, 0);
  return (
    <section className="card" aria-labelledby="gates-ops-title">
      <SectionHead id="gates-ops-title" title="Admissions by gate" />
      <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="gates-ops-title">
        <table>
          <thead>
            <tr>
              <th scope="col">Gate</th>
              <th scope="col" className="num">
                Admitted
              </th>
              <th scope="col" className="num">
                Share
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
                <td className="num muted">{admitted ? percent(gate.admitted / admitted) : '—'}</td>
                <td className="num">{gate.denied}</td>
                <td className="num muted">{gate.lastScanAt ? formatTimeInZone(gate.lastScanAt, zone) : '—'}</td>
              </tr>
            ))}
            {gates.length === 0 ? <TableMessage colSpan={5}>No scans yet. Add gates and scanner devices on the Access tab.</TableMessage> : null}
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

function Policies({ policies, zone }: { policies: OperationsSummary['policies']; zone: string }) {
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
                      {formatTimeInZone(policy.opensAt, zone)} – {formatTimeInZone(policy.closesAt, zone)}
                    </span>
                  </div>
                  <span className="muted num">
                    {policy.capacity === null ? `${policy.admitted} admitted` : `${policy.admitted}/${policy.capacity} · ${percent(policy.admitted / policy.capacity)}`}
                  </span>
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
