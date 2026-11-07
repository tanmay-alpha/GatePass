import { useCallback, useRef, useState } from 'react';
import type { EventSummary, ScanRecord } from '../../shared/types';
import { api, formatTime } from '../api';
import { Badge, ErrorNote, TableMessage, errorMessage } from '../ui';
import { LIVE_POLL_MS, usePolling } from './hooks';

const MAX_ROWS = 300;

/** Polls for scans newer than the last seen id; cheap thanks to the (event_id, id) index. */
export function ScanFeed({ token, event, onChanged }: { token: string; event: EventSummary; onChanged: () => Promise<void> }) {
  const [scans, setScans] = useState<ScanRecord[] | null>(null);
  const [error, setError] = useState('');
  const lastId = useRef(0);

  const poll = useCallback(async () => {
    try {
      const fresh = await api<ScanRecord[]>(`/api/events/${event.id}/scans?after=${lastId.current}&limit=100`, token);
      const hadPrevious = lastId.current > 0;
      if (fresh.length) lastId.current = fresh[0].id;
      setScans((current) => [...fresh, ...(current ?? [])].slice(0, MAX_ROWS));
      // New check-ins change the event's counters in the header.
      if (fresh.length && hadPrevious) void onChanged();
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [event.id, token, onChanged]);

  usePolling(poll, LIVE_POLL_MS);

  return (
    <div className="stack">
      <ErrorNote message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Result</th>
              <th scope="col">Attendee</th>
              <th scope="col">Gate</th>
              <th scope="col">Device</th>
            </tr>
          </thead>
          <tbody>
            {scans?.map((scan) => (
              <tr key={scan.id}>
                <td className="small num">{formatTime(scan.createdAt)}</td>
                <td>
                  <Badge value={scan.outcome} />
                </td>
                <td>{scan.passId ? scan.attendeeName || <code>{scan.passId.slice(0, 8)}</code> : <span className="muted">—</span>}</td>
                <td className="small">{scan.gateName ?? <span className="muted">Any gate</span>}</td>
                <td className="small">{scan.scannerLabel}</td>
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
