import { Ban, Copy, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { EventSummary, Gate, Scanner } from '../../shared/types';
import { api, formatDateTime, renderQrObjectUrl } from '../api';
import { useConfirm } from '../dialog';
import { ErrorNote, SectionHead, TableMessage, ToneBadge, errorMessage } from '../ui';
import { useResource } from './hooks';
import { useToast } from './toast';

/** Door devices: each gets its own event-scoped key, optionally bound to one gate. */
export function ScannersSection({ token, event, gates }: { token: string; event: EventSummary; gates: Gate[] }) {
  const scanners = useResource<Scanner[]>(`/api/events/${event.id}/scanners`, token);
  const [label, setLabel] = useState('');
  const [gateId, setGateId] = useState('');
  const [created, setCreated] = useState<{ label: string; gateName: string | null; setupUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const closed = event.status !== 'active';

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ scanner: Scanner; key: string }>(`/api/events/${event.id}/scanners`, token, {
        body: { label: label.trim(), gateId: gateId || null }
      });
      // The key travels in the URL fragment, which browsers never send to the server.
      setCreated({ label: result.scanner.label, gateName: result.scanner.gateName, setupUrl: `${window.location.origin}/scan#key=${result.key}` });
      setLabel('');
      await scanners.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(scanner: Scanner) {
    const ok = await confirm({
      title: `Revoke “${scanner.label}”?`,
      body: 'The device is signed out on its next request and cannot scan again with this key. Its past scans stay in the history. To use the device again, add it as a new scanner.',
      confirmLabel: 'Revoke device',
      danger: true
    });
    if (!ok) return;
    setError('');
    try {
      await api(`/api/scanners/${scanner.id}/revoke`, token, { method: 'POST' });
      await scanners.reload();
      notify(`“${scanner.label}” revoked`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card" aria-labelledby="scanners-title">
      <SectionHead
        id="scanners-title"
        title="Scanner devices"
        description="Each door device gets its own key, limited to this event. Revoke a key if a device is lost; its scans stay in the history."
      />
      <form className="device-form" onSubmit={create}>
        <label className="grow">
          Device label
          <input placeholder="e.g. North door phone 1" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} required disabled={closed} />
        </label>
        <label>
          Gate
          <select value={gateId} onChange={(e) => setGateId(e.target.value)} disabled={closed}>
            <option value="">Any gate</option>
            {gates.map((gate) => (
              <option key={gate.id} value={gate.id}>
                {gate.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" disabled={busy || closed || !label.trim()}>
          <Plus size={16} aria-hidden /> {busy ? 'Adding…' : 'Add device'}
        </button>
      </form>
      {closed ? <p className="muted small">This event is archived; reopen it in Settings to add devices.</p> : null}
      <ErrorNote message={error || scanners.error} />
      {created ? <ScannerSetup token={token} {...created} onClose={() => setCreated(null)} /> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">Gate</th>
              <th scope="col">Created</th>
              <th scope="col">Last used</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {scanners.data?.map((scanner) => (
              <tr key={scanner.id}>
                <td>{scanner.label}</td>
                <td>{scanner.gateName ?? <span className="muted">Any gate</span>}</td>
                <td className="small">{formatDateTime(scanner.createdAt)}</td>
                <td className="small">{formatDateTime(scanner.lastUsedAt)}</td>
                <td>{scanner.revokedAt ? <ToneBadge tone="bad">Revoked</ToneBadge> : <ToneBadge tone="ok">Active</ToneBadge>}</td>
                <td className="row-actions">
                  {scanner.revokedAt ? null : (
                    <button className="btn btn-ghost btn-small danger" onClick={() => void revoke(scanner)} aria-label={`Revoke ${scanner.label}`}>
                      <Ban size={14} aria-hidden /> Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {scanners.data === null && !scanners.error ? <TableMessage colSpan={6}>Loading devices…</TableMessage> : null}
            {scanners.data?.length === 0 ? <TableMessage colSpan={6}>No devices yet. Add one above, then open its setup link on the door phone.</TableMessage> : null}
          </tbody>
        </table>
      </div>
      {dialog}
    </section>
  );
}

interface SetupProps {
  token: string;
  label: string;
  gateName: string | null;
  setupUrl: string;
  onClose: () => void;
}

function ScannerSetup({ token, label, gateName, setupUrl, onClose }: SetupProps) {
  const [src, setSrc] = useState('');
  const [qrError, setQrError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let url = '';
    let live = true;
    renderQrObjectUrl(token, setupUrl, {})
      .then((value) => {
        url = value;
        if (live) setSrc(value);
        else URL.revokeObjectURL(value);
      })
      .catch((err) => live && setQrError(errorMessage(err)));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, setupUrl]);

  async function copy() {
    await navigator.clipboard.writeText(setupUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="issued setup" role="region" aria-label={`Setup for ${label}`}>
      <div className="setup-body">
        {src ? <img src={src} alt={`Setup QR code for ${label}`} /> : <div className="qr-placeholder">{qrError ? <span className="small">{qrError}</span> : null}</div>}
        <div className="stack-sm">
          <h3>
            Set up “{label}” · {gateName ?? 'Any gate'}
          </h3>
          <p className="warning-text">Scan this code with the door device's camera, or open the link on it. The key is shown only once.</p>
          <label>
            Setup link
            <input readOnly value={setupUrl} onFocus={(e) => e.target.select()} />
          </label>
          <div className="actions">
            <button className="btn btn-secondary btn-small" onClick={() => void copy()}>
              <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Copy link'}
            </button>
            <button className="btn btn-ghost btn-small" onClick={onClose}>
              Done
            </button>
          </div>
          <span className="sr-only" role="status">
            {copied ? 'Setup link copied' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
