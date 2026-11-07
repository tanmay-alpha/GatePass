import { useEffect, useRef, useState } from 'react';
import type { EventSummary, ScanRecord } from '../../shared/types';
import { api, formatDateTime } from '../api';
import { Badge, ErrorNote, errorMessage } from '../ui';

const POLL_MS = 3000;

/** Polls for scans newer than the last seen id; cheap thanks to the (event_id, id) index. */
export function ScansPanel({ token, event, onChanged }: { token: string; event: EventSummary; onChanged: () => Promise<void> }) {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [error, setError] = useState('');
  const lastId = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    lastId.current = 0;
    setScans([]);

    async function poll() {
      try {
        const fresh = await api<ScanRecord[]>(`/api/events/${event.id}/scans?after=${lastId.current}&limit=100`, token);
        if (stopped) return;
        if (fresh.length) {
          const hadPrevious = lastId.current > 0;
          lastId.current = fresh[0].id;
          setScans((current) => [...fresh, ...current].slice(0, 300));
          if (hadPrevious) void onChanged();
        }
        setError('');
      } catch (err) {
        if (!stopped) setError(errorMessage(err));
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [event.id, token, onChanged]);

  const admitted = scans.filter((scan) => scan.outcome === 'admitted').length;

  return (
    <div className="stack">
      <p className="muted">
        <span className="live-dot" aria-hidden /> Updating every {POLL_MS / 1000} s · {scans.length} recent scans, {admitted} admitted
      </p>
      <ErrorNote message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Result</th>
              <th>Attendee</th>
              <th>Device</th>
            </tr>
          </thead>
          <tbody>
            {scans.map((scan) => (
              <tr key={scan.id}>
                <td className="small">{formatDateTime(scan.createdAt)}</td>
                <td>
                  <Badge value={scan.outcome} />
                </td>
                <td>{scan.passId ? scan.attendeeName || <code>{scan.passId.slice(0, 8)}</code> : <span className="muted">—</span>}</td>
                <td className="small">{scan.scannerLabel}</td>
              </tr>
            ))}
            {scans.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No scans yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
