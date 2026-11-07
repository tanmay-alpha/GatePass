import { Ban, Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { EventSummary, Scanner } from '../../shared/types';
import { api, formatDateTime, renderQrObjectUrl } from '../api';
import { ErrorNote, errorMessage } from '../ui';

export function ScannersPanel({ token, event }: { token: string; event: EventSummary }) {
  const [scanners, setScanners] = useState<Scanner[]>([]);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ label: string; setupUrl: string } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setScanners(await api<Scanner[]>(`/api/events/${event.id}/scanners`, token));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [event.id, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const result = await api<{ scanner: Scanner; key: string }>(`/api/events/${event.id}/scanners`, token, { body: { label } });
      // The key travels in the URL fragment, which browsers never send to the server.
      setCreated({ label: result.scanner.label, setupUrl: `${window.location.origin}/scan#key=${result.key}` });
      setLabel('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revoke(scanner: Scanner) {
    if (!window.confirm(`Revoke "${scanner.label}"? That device will be signed out on its next scan.`)) return;
    try {
      await api(`/api/scanners/${scanner.id}/revoke`, token, { method: 'POST' });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="stack">
      <p className="muted">
        Each door device gets its own key, limited to this event. Revoke a key if a device is lost; its scans stay in the history.
      </p>
      <form className="inline-form" onSubmit={create}>
        <input placeholder="Device label, e.g. North door" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} required aria-label="Device label" />
        <button className="btn btn-primary" disabled={event.status !== 'active'}>
          <Plus size={16} aria-hidden /> Add scanner
        </button>
      </form>
      <ErrorNote message={error} />
      {created ? <ScannerSetup {...created} onClose={() => setCreated(null)} /> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {scanners.map((scanner) => (
              <tr key={scanner.id}>
                <td>{scanner.label}</td>
                <td className="small">{formatDateTime(scanner.createdAt)}</td>
                <td className="small">{formatDateTime(scanner.lastUsedAt)}</td>
                <td>{scanner.revokedAt ? <span className="badge badge-bad">Revoked</span> : <span className="badge badge-ok">Active</span>}</td>
                <td className="row-actions">
                  {scanner.revokedAt ? null : (
                    <button className="btn btn-ghost btn-small danger" onClick={() => void revoke(scanner)}>
                      <Ban size={14} aria-hidden /> Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {scanners.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No scanners yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScannerSetup({ label, setupUrl, onClose }: { label: string; setupUrl: string; onClose: () => void }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    void renderQrObjectUrl(setupUrl, {}).then((value) => {
      url = value;
      setSrc(value);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [setupUrl]);

  return (
    <div className="issued setup">
      <div className="setup-body">
        {src ? <img src={src} alt="Scanner setup QR code" /> : <div className="qr-placeholder" />}
        <div>
          <h3>Set up “{label}”</h3>
          <p>Scan this code with the door device's camera, or open the link on it. The key is shown only once.</p>
          <input readOnly value={setupUrl} onFocus={(e) => e.target.select()} aria-label="Scanner setup link" />
          <div className="actions">
            <button className="btn btn-secondary btn-small" onClick={() => void navigator.clipboard.writeText(setupUrl)}>
              Copy link
            </button>
            <button className="btn btn-ghost btn-small" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
