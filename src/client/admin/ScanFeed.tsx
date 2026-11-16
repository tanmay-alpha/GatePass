import { RefreshCw } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import type { EventSummary, ScanRecord } from '../../shared/types';
import { ErrorNote, OutcomeBadge, TableMessage, errorMessage } from '../ui';
import { formatTimeInZone, zoneLabel } from '../time';
import { LIVE_POLL_MS, usePolling } from './hooks';
import { adminApi } from './http';

const MAX_ROWS = 300;

/** Polls for scans newer than the last seen id; cheap thanks to the (event_id, id) index. */
export function ScanFeed({ event, onChanged }: { event: EventSummary; onChanged: () => Promise<void> }) {
  const [scans, setScans] = useState<ScanRecord[] | null>(null);
  const [error, setError] = useState('');
  const lastId = useRef(0);
  /** False until the first poll; that poll returns history, not new scans. */
  const loaded = useRef(false);
  /** A manual retry must not overlap a scheduled poll: both would fetch after the same id and list scans twice. */
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const fresh = await adminApi<ScanRecord[]>(`/api/events/${event.id}/scans?after=${lastId.current}&limit=100`);
      const isNew = loaded.current;
      loaded.current = true;
      if (fresh.length) lastId.current = fresh[0].id;
      setScans((current) => [...fresh, ...(current ?? [])].slice(0, MAX_ROWS));
      // New check-ins change the event's counters in the header and the setup checklist.
      if (fresh.length && isNew) void onChanged();
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
    }
  }, [event.id, onChanged]);

  usePolling(poll, LIVE_POLL_MS);

  return (
    <div className="stack-sm">
      {error ? (
        <div className="actions">
          <ErrorNote message={scans ? `The feed could not refresh: ${error} Older scans stay listed; it keeps retrying every ${LIVE_POLL_MS / 1000} s.` : error} />
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void poll()}>
            <RefreshCw size={14} aria-hidden /> Retry now
          </button>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="table-cards">
          <thead>
            <tr>
              <th scope="col">Time ({zoneLabel(event.timeZone, event.startsAt)})</th>
              <th scope="col">Result</th>
              <th scope="col">Attendee</th>
              <th scope="col">Gate</th>
              <th scope="col">Device</th>
            </tr>
          </thead>
          <tbody>
            {scans?.map((scan) => (
              <tr key={scan.id}>
                <td className="muted nowrap cell-meta">{formatTimeInZone(scan.createdAt, event.timeZone)}</td>
                <td className="cell-badge">
                  <OutcomeBadge outcome={scan.outcome} />
                </td>
                <td className="strong cell-primary">{scan.passId ? scan.attendeeName || <code>{scan.passId.slice(0, 8)}</code> : <span className="muted">—</span>}</td>
                <td className="cell-sub">{scan.gateName ?? <span className="muted">Any gate</span>}</td>
                <td className="muted cell-sub">{scan.scannerLabel}</td>
              </tr>
            ))}
            {scans === null && !error ? <TableMessage colSpan={5}>Loading scans…</TableMessage> : null}
            {scans?.length === 0 ? <TableMessage colSpan={5}>No scans yet. Scans appear here within a few seconds of happening at the door.</TableMessage> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
