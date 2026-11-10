import { Ban, KeyRound, Plus, Smartphone } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { EventSummary, Gate, Scanner } from '../../shared/types';
import { useConfirm } from '../dialog';
import { ErrorNote, SectionHead, TableMessage, ToneBadge, errorMessage } from '../ui';
import { formatShortInZone, zoneLabel } from '../time';
import { CopyField } from './CopyField';
import { useResource } from './hooks';
import { adminApi, adminQrUrl } from './http';
import { can } from './model';
import { useToast } from './toast';

interface Setup {
  label: string;
  gateName: string | null;
  setupUrl: string;
  /** A rotated key replaces one that just stopped working. */
  rotated: boolean;
}

/** The key travels in the URL fragment, which browsers never send to the server. */
const setupUrlFor = (key: string) => `${window.location.origin}/scan#key=${key}`;

/** Door devices: each gets its own event-scoped key, optionally bound to one gate. */
export function ScannersSection({ event, gates, onChanged }: { event: EventSummary; gates: Gate[]; onChanged: () => Promise<void> }) {
  const scanners = useResource<Scanner[]>(`/api/events/${event.id}/scanners`);
  const [label, setLabel] = useState('');
  const [gateId, setGateId] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const editable = can(event, 'scanners') && event.status !== 'archived';
  const zone = event.timeZone;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await adminApi<{ scanner: Scanner; key: string }>(`/api/events/${event.id}/scanners`, { body: { label: label.trim(), gateId: gateId || null } });
      setSetup({ label: result.scanner.label, gateName: result.scanner.gateName, setupUrl: setupUrlFor(result.key), rotated: false });
      setLabel('');
      await Promise.all([scanners.reload(), onChanged()]);
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
    setPending(scanner.id);
    setError('');
    try {
      await adminApi(`/api/scanners/${scanner.id}/revoke`, { method: 'POST' });
      await Promise.all([scanners.reload(), onChanged()]);
      notify(`“${scanner.label}” revoked`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function rotate(scanner: Scanner) {
    const ok = await confirm({
      title: `Replace the key for “${scanner.label}”?`,
      body: 'The current key and setup link stop working immediately and the device is signed out on its next scan. You get a new setup link to open on the device. History and gate binding stay the same.',
      confirmLabel: 'Rotate key'
    });
    if (!ok) return;
    setPending(scanner.id);
    setError('');
    try {
      const result = await adminApi<{ scanner: Scanner; key: string }>(`/api/scanners/${scanner.id}/rotate`, { method: 'POST' });
      setSetup({ label: result.scanner.label, gateName: result.scanner.gateName, setupUrl: setupUrlFor(result.key), rotated: true });
      await scanners.reload();
      notify(`New key created for “${scanner.label}”`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={setup ? 'devices-grid' : undefined}>
      <section className="card" aria-labelledby="scanners-title">
        <SectionHead
          id="scanners-title"
          title="Scanner devices"
          description="Each door device gets its own key, limited to this event. Rotate a key if a setup link leaked; revoke it if a device is lost. Scans stay in the history."
        />
        {editable ? (
          <form className="device-form" onSubmit={create}>
            <label className="grow">
              Device label
              <input id="device-label-input" placeholder="e.g. North door phone 1" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} required />
            </label>
            <label>
              Gate
              <select value={gateId} onChange={(e) => setGateId(e.target.value)}>
                <option value="">Any gate</option>
                {gates.map((gate) => (
                  <option key={gate.id} value={gate.id}>
                    {gate.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-secondary" disabled={busy || !label.trim()}>
              <Plus size={16} aria-hidden /> {busy ? 'Adding…' : 'Add device'}
            </button>
          </form>
        ) : null}
        <ErrorNote message={error || scanners.error} />
        <div className="table-wrap">
          <table aria-busy={scanners.loading}>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Gate</th>
                <th scope="col">Created</th>
                <th scope="col">Last used ({zoneLabel(zone, event.startsAt)})</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {scanners.data?.map((scanner) => (
                <tr key={scanner.id}>
                  <td className="strong">
                    <span className="with-icon">
                      <Smartphone size={15} className="muted" aria-hidden /> {scanner.label}
                    </span>
                  </td>
                  <td>{scanner.gateName ?? <span className="muted">Any gate</span>}</td>
                  <td className="num muted nowrap">{formatShortInZone(scanner.createdAt, zone)}</td>
                  <td className="num muted nowrap">{scanner.lastUsedAt ? formatShortInZone(scanner.lastUsedAt, zone) : 'Never'}</td>
                  <td>{scanner.revokedAt ? <ToneBadge tone="muted">Revoked</ToneBadge> : <ToneBadge tone="ok">Active</ToneBadge>}</td>
                  <td className="row-actions">
                    {scanner.revokedAt || !editable ? null : (
                      <>
                        <button className="btn btn-ghost btn-small" onClick={() => void rotate(scanner)} disabled={pending === scanner.id} aria-label={`Rotate key for ${scanner.label}`}>
                          <KeyRound size={14} aria-hidden /> Rotate key
                        </button>
                        <button className="btn btn-secondary btn-small danger" onClick={() => void revoke(scanner)} disabled={pending === scanner.id} aria-label={`Revoke ${scanner.label}`}>
                          <Ban size={14} aria-hidden /> Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {scanners.data === null && !scanners.error ? <TableMessage colSpan={6}>Loading devices…</TableMessage> : null}
              {scanners.data?.length === 0 ? (
                <TableMessage colSpan={6}>{editable ? 'No devices yet. Add one above, then open its setup link on the door phone.' : 'No devices yet.'}</TableMessage>
              ) : null}
            </tbody>
          </table>
        </div>
        {dialog}
      </section>
      {setup ? <ScannerSetup {...setup} onClose={() => setSetup(null)} /> : null}
    </div>
  );
}

function ScannerSetup({ label, gateName, setupUrl, rotated, onClose }: Setup & { onClose: () => void }) {
  const [src, setSrc] = useState('');
  const [qrError, setQrError] = useState('');

  useEffect(() => {
    let url = '';
    let live = true;
    adminQrUrl(setupUrl, {})
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
  }, [setupUrl]);

  return (
    <section className="card setup" role="region" aria-label={`Setup for ${label}`}>
      <SectionHead title={rotated ? `New key for “${label}”` : `Set up “${label}”`} description={gateName ?? 'Any gate'} />
      <div className="setup-qr">{src ? <img src={src} alt={`Setup QR code for ${label}`} /> : <div className="qr-placeholder">{qrError ? <span className="small">{qrError}</span> : null}</div>}</div>
      <p className="muted small setup-note">
        {rotated ? 'The old setup link no longer works. ' : ''}Scan with the door device's camera to register it as a scanner, or open the link on it. The key is shown only once.
      </p>
      <CopyField label="Setup link" value={setupUrl} />
      <button className="btn btn-primary btn-block" onClick={onClose}>
        Done
      </button>
    </section>
  );
}
