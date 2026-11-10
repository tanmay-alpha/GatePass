import { Download, Info, TriangleAlert } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { AlertKind, EventSummary, OperationsSummary, StoredScanOutcome } from '../../shared/types';
import { Bar, EmptyState, ErrorNote, OutcomeBadge, SectionHead, Stat, TableMessage, ToneBadge, capacityTone, errorMessage, type Tone } from '../ui';
import { formatTimeInZone, zoneLabel } from '../time';
import { LIVE_POLL_MS, usePolling } from './hooks';
import { adminApi, adminDownload } from './http';
import { can } from './model';
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

type ScannerState = OperationsSummary['scanners'][number]['state'];

const SCANNER_STATE: Record<ScannerState, { label: string; tone: Tone }> = {
  recent: { label: 'Recent', tone: 'ok' },
  idle: { label: 'Idle', tone: 'warn' },
  never_used: { label: 'Never used', tone: 'muted' },
  revoked: { label: 'Revoked', tone: 'bad' }
};

/** Live door picture: turnout, capacity, devices, alerts, timeline, gates, policies and the scan feed, refreshed while visible. */
export function OperationsPanel({ event, onChanged }: { event: EventSummary; onChanged: () => Promise<void> }) {
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [error, setError] = useState('');

  const poll = useCallback(async () => {
    try {
      setSummary(await adminApi<OperationsSummary>(`/api/events/${event.id}/operations`));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [event.id]);

  usePolling(poll, LIVE_POLL_MS);

  return (
    <div className="stack-lg">
      {can(event, 'export') ? <Exports event={event} /> : null}
      <ErrorNote message={error} />
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
            {summary ? <span className="num"> · updated {formatTimeInZone(summary.generatedAt, event.timeZone)}</span> : null}
          </span>
        </SectionHead>
        <ScanFeed event={event} onChanged={onChanged} />
      </section>
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
  const { totals, passes, capacity } = summary;
  return (
    <>
      <div className="stats stats-lg">
        <Stat label="Admitted / issued" value={`${passes.redeemed} / ${passes.issued}`} />
        <Stat label="Turnout" value={passes.issued ? `${Math.round((passes.redeemed / passes.issued) * 100)}%` : '—'} />
        <Stat label="Capacity left" value={capacity.remaining === null ? 'No limit' : capacity.remaining} />
        <Stat label="Denied scans" value={totals.denied} />
      </div>
      <div className="ops-grid">
        <PassStates passes={passes} capacity={capacity} />
        <Scanners scanners={summary.scanners} zone={zone} />
      </div>
      <div className="ops-grid">
        <Alerts alerts={summary.alerts} zone={zone} />
        <Timeline buckets={summary.timeline} outcomes={summary.outcomes} total={totals.scans} zone={zone} />
      </div>
      <div className="ops-grid">
        <Gates gates={summary.gates} zone={zone} />
        <Policies policies={summary.policies} zone={zone} />
      </div>
    </>
  );
}

const PASS_ROWS: Array<{ key: 'active' | 'redeemed' | 'revoked' | 'expired'; label: string; tone: Tone; note: string }> = [
  { key: 'active', label: 'Active', tone: 'info', note: 'valid, not used yet' },
  { key: 'redeemed', label: 'Redeemed', tone: 'ok', note: 'admitted' },
  { key: 'revoked', label: 'Revoked', tone: 'bad', note: 'cancelled by an organizer' },
  { key: 'expired', label: 'Expired', tone: 'muted', note: 'unused past expiry' }
];

function PassStates({ passes, capacity }: { passes: OperationsSummary['passes']; capacity: OperationsSummary['capacity'] }) {
  return (
    <section className="card" aria-labelledby="pass-states-title">
      <SectionHead id="pass-states-title" title="Passes">
        <span className="card-meta num">{passes.issued} issued</span>
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
        <span className="card-meta">Idle = no request for 10 min</span>
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

/** Stacked bars (admitted below, denied on top) scaled to the busiest bucket, with the outcome breakdown underneath. */
function Timeline({ buckets, outcomes, total, zone }: { buckets: OperationsSummary['timeline']; outcomes: OperationsSummary['outcomes']; total: number; zone: string }) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.admitted + bucket.denied));
  const busiest = buckets.find((bucket) => bucket.admitted + bucket.denied === peak);
  const ticks = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])].filter((index) => index >= 0);
  const time = (iso: string) => formatTimeInZone(iso, zone);
  return (
    <section className="card" aria-labelledby="timeline-title">
      <SectionHead id="timeline-title" title={`Scans per 15 min (${buckets.length ? zoneLabel(zone, buckets[0].bucketStart) : zone})`}>
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
            aria-label={`Scans per 15 minutes from ${time(buckets[0].bucketStart)} to ${time(buckets[buckets.length - 1].bucketStart)}.${busiest ? ` Busiest: ${peak} scans at ${time(busiest.bucketStart)}.` : ''}`}
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

function Gates({ gates, zone }: { gates: OperationsSummary['gates']; zone: string }) {
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
                <td className="num muted">{gate.lastScanAt ? formatTimeInZone(gate.lastScanAt, zone) : '—'}</td>
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
