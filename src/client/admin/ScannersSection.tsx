import { Ban, KeyRound, Plus, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { AdmissionPolicy, EventSummary, Gate, Scanner, ScannerSetupLink } from '../../shared/types';
import { Consequences, useConfirm } from '../dialog';
import { ErrorNote, SectionHead, TableMessage, ToneBadge, errorMessage } from '../ui';
import { formatShortInZone, formatTimeInZone, zoneLabel } from '../time';
import { CopyField } from './CopyField';
import { LIVE_POLL_MS, usePolling, type Resource } from './hooks';
import { adminApi, adminQrUrl } from './http';
import { canScan, deviceStop, doorsOpen } from './live-impact';
import { can } from './model';
import { ScannerTestCode } from './ScannerTestCode';
import { useToast } from './toast';

interface Setup {
  scannerId: string;
  label: string;
  gateName: string | null;
  setupUrl: string;
  expiresAt: string;
  /** A rotated key replaces one that just stopped working. */
  rotated: boolean;
}

/**
 * The one-time setup code travels in the URL fragment, which browsers never
 * send to a server. The link uses this page's origin, like the rest of the UI.
 */
const setupOf = (result: ScannerSetupLink, rotated: boolean): Setup => ({
  scannerId: result.scanner.id,
  label: result.scanner.label,
  gateName: result.scanner.gateName,
  setupUrl: `${window.location.origin}/scan${new URL(result.enrollment.url).hash}`,
  expiresAt: result.enrollment.expiresAt,
  rotated
});

interface Props {
  event: EventSummary;
  gates: Gate[];
  /** Policy windows widen the time the doors are open. */
  policies: AdmissionPolicy[];
  scanners: Resource<Scanner[]>;
  onChanged: () => Promise<void>;
}

/** Door devices: each gets its own event-scoped key, optionally bound to one gate. */
export function ScannersSection({ event, gates, policies, scanners, onChanged }: Props) {
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

  // A phone claims its setup link elsewhere: while a link is waiting, watch for that, then refresh
  // the event (setup checklist, "Ready for doors") and close the setup panel of the device that enrolled.
  const waiting = scanners.data?.some((scanner) => scanner.setup === 'pending' && !scanner.revokedAt) ?? false;
  const ready = scanners.data?.filter((scanner) => !scanner.revokedAt && (scanner.setup === 'enrolled' || scanner.setup === 'legacy')).length ?? null;
  const knownReady = useRef<number | null>(null);
  const { reload } = scanners;
  usePolling(
    useCallback(async () => {
      if (waiting) await reload();
    }, [waiting, reload]),
    LIVE_POLL_MS
  );
  useEffect(() => {
    if (ready === null) return;
    if (knownReady.current !== null && ready !== knownReady.current) void onChanged();
    knownReady.current = ready;
  }, [ready, onChanged]);
  const shownEnrolled = setup !== null && scanners.data?.find((scanner) => scanner.id === setup.scannerId)?.setup === 'enrolled';
  const labelInput = useRef<HTMLInputElement>(null);
  const setupPanel = useRef<HTMLElement>(null);
  // Closing the panel unmounts what had focus: hand it to the device label so keyboard users (and the next
  // device entry) continue from there instead of from the top of the page.
  const closeSetup = useCallback(() => {
    labelInput.current?.focus({ preventScroll: true });
    setSetup(null);
  }, []);
  useEffect(() => {
    if (!shownEnrolled) return;
    const active = document.activeElement;
    if (active === null || active === document.body || setupPanel.current?.contains(active)) closeSetup();
    else setSetup(null);
  }, [shownEnrolled, closeSetup]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await adminApi<ScannerSetupLink>(`/api/events/${event.id}/scanners`, { body: { label: label.trim(), gateId: gateId || null } });
      setSetup(setupOf(result, false));
      setLabel('');
      await Promise.all([scanners.reload(), onChanged()]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** While the doors are open, taking a working device away is confirmed against what it means for its door. */
  function stopsDoor(scanner: Scanner): string[] {
    return doorsOpen(event, policies) && canScan(scanner) ? deviceStop(scanner, scanners.data ?? [], (iso) => formatTimeInZone(iso, zone)) : [];
  }

  async function revoke(scanner: Scanner) {
    const impact = stopsDoor(scanner);
    const lead = 'The device is signed out on its next request and cannot scan again with this key. Its past scans stay in the history. To use the device again, add it as a new scanner.';
    const ok = await confirm({
      title: impact.length ? `Revoke “${scanner.label}” while the doors are open?` : `Revoke “${scanner.label}”?`,
      body: impact.length ? <Consequences lead={lead} items={impact} /> : lead,
      confirmLabel: 'Revoke device',
      danger: true,
      acknowledge: impact.length ? 'I understand this device stops admitting now.' : undefined
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
    const enrolled = scanner.setup === 'enrolled' || scanner.setup === 'legacy';
    const impact = stopsDoor(scanner);
    const lead = enrolled
      ? 'The current key stops working immediately and the device is signed out on its next scan. You get a new one-time setup link to open on the device. History and gate binding stay the same.'
      : 'Any earlier setup link for this device stops working. History and gate binding stay the same.';
    const ok = await confirm({
      title: enrolled ? `Replace the key for “${scanner.label}”?` : `New setup link for “${scanner.label}”?`,
      body: impact.length ? <Consequences lead={lead} items={impact} /> : lead,
      confirmLabel: enrolled ? 'Rotate key' : 'Create link',
      acknowledge: impact.length ? 'I understand this device stops admitting until it is set up again.' : undefined
    });
    if (!ok) return;
    setPending(scanner.id);
    setError('');
    try {
      const result = await adminApi<ScannerSetupLink>(`/api/scanners/${scanner.id}/rotate`, { method: 'POST' });
      setSetup(setupOf(result, enrolled));
      await scanners.reload();
      notify(enrolled ? `New key requested for “${scanner.label}”` : `New setup link for “${scanner.label}”`);
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
          description="Each door device gets its own key, limited to this event, through a setup link that works once and expires after an hour. Rotate a key if a device may be compromised; revoke it if a device is lost. Scans stay in the history."
        />
        {editable ? (
          <form className="device-form" onSubmit={create}>
            <label className="grow">
              Device label
              <input ref={labelInput} id="device-label-input" placeholder="e.g. North door phone 1" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} required />
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
          <table className="table-cards" aria-busy={scanners.loading}>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Gate</th>
                <th scope="col" className="num">Created</th>
                <th scope="col" className="num">Last used ({zoneLabel(zone, event.startsAt)})</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {scanners.data?.map((scanner) => (
                <tr key={scanner.id}>
                  <td className="strong cell-primary">
                    <span className="with-icon">
                      <Smartphone size={15} className="muted" aria-hidden /> {scanner.label}
                    </span>
                  </td>
                  <td data-label="Gate">{scanner.gateName ?? <span className="muted">Any gate</span>}</td>
                  <td className="num muted nowrap" data-label="Created">
                    {formatShortInZone(scanner.createdAt, zone)}
                  </td>
                  <td className="num muted nowrap" data-label="Last used">
                    {scanner.lastUsedAt ? formatShortInZone(scanner.lastUsedAt, zone) : 'Never'}
                  </td>
                  <td className="cell-badge">
                    <ScannerState scanner={scanner} zone={zone} />
                  </td>
                  <td className="row-actions">
                    {scanner.revokedAt || !editable ? null : (
                      <>
                        <button className="btn btn-ghost btn-small" onClick={() => void rotate(scanner)} disabled={pending === scanner.id} aria-label={`${scanner.setup === 'enrolled' || scanner.setup === 'legacy' ? 'Rotate key' : 'New setup link'} for ${scanner.label}`}>
                          <KeyRound size={14} aria-hidden /> {scanner.setup === 'enrolled' || scanner.setup === 'legacy' ? 'Rotate key' : 'New setup link'}
                        </button>
                        <button className="btn btn-ghost btn-small danger" onClick={() => void revoke(scanner)} disabled={pending === scanner.id} aria-label={`Revoke ${scanner.label}`}>
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
        <ScannerTestCode />
        {dialog}
      </section>
      {setup ? <ScannerSetup {...setup} panel={setupPanel} zone={zone} startsAt={event.startsAt} onClose={closeSetup} /> : null}
    </div>
  );
}

function ScannerState({ scanner, zone }: { scanner: Scanner; zone: string }) {
  if (scanner.revokedAt) return <ToneBadge tone="muted">Revoked</ToneBadge>;
  if (scanner.setup === 'pending') {
    return (
      <span title={`The setup link works until ${formatShortInZone(scanner.setupExpiresAt!, zone)}`}>
        <ToneBadge tone="info">Waiting for device</ToneBadge>
      </span>
    );
  }
  if (scanner.setup === 'expired') return <ToneBadge tone="warn">Setup link expired</ToneBadge>;
  return <ToneBadge tone="ok">Active</ToneBadge>;
}

function ScannerSetup({ label, gateName, setupUrl, expiresAt, rotated, panel, zone, startsAt, onClose }: Setup & { panel: RefObject<HTMLElement | null>; zone: string; startsAt: string; onClose: () => void }) {
  const [src, setSrc] = useState('');

  // On a phone the panel stacks below the device list and the camera test code, out of sight of the button
  // that opened it: bring it into view and move focus to it, so the link and its Copy button come next.
  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'nearest' });
    panel.current?.focus({ preventScroll: true });
  }, [setupUrl, panel]);
  const [qrError, setQrError] = useState('');

  // The image keeps showing its URL until a new one replaces it, so a URL is revoked only once replaced or unmounted.
  const shown = useRef('');
  useEffect(() => () => URL.revokeObjectURL(shown.current), []);
  useEffect(() => {
    let live = true;
    setQrError('');
    adminQrUrl(setupUrl, {})
      .then((value) => {
        if (!live) return URL.revokeObjectURL(value);
        URL.revokeObjectURL(shown.current);
        shown.current = value;
        setSrc(value);
      })
      .catch((err) => {
        if (!live) return;
        URL.revokeObjectURL(shown.current);
        shown.current = '';
        setSrc('');
        setQrError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [setupUrl]);

  return (
    <section ref={panel} className="card setup" role="region" aria-label={`Setup for ${label}`} tabIndex={-1}>
      <SectionHead title={rotated ? `New key for “${label}”` : `Set up “${label}”`} description={gateName ?? 'Any gate'} />
      <div className="setup-qr">{src ? <img src={src} alt={`Setup QR code for ${label}`} /> : <div className="qr-placeholder">{qrError ? <span className="small">{qrError}</span> : null}</div>}</div>
      <p className="muted small setup-note">
        {rotated ? 'The old key no longer works. ' : ''}Scan this code with the door device's camera, or open the link on it. The link works once, on one device, until{' '}
        {formatTimeInZone(expiresAt, zone)} ({zoneLabel(zone, startsAt)}). It is shown only here.
      </p>
      <CopyField label="Setup link" value={setupUrl} />
      <button className="btn btn-primary btn-block" onClick={onClose}>
        Done
      </button>
    </section>
  );
}
