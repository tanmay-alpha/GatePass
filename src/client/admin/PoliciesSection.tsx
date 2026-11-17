import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, Gate, Scanner } from '../../shared/types';
import { Consequences, Modal, useConfirm } from '../dialog';
import { CapacityLine, EmptyState, ErrorNote, FieldError, SectionHead, describedBy, errorMessage, focusFirstInvalid } from '../ui';
import { formatDateTimeInZone, formatShortInZone, formatTimeInZone, fromZoneInput, toZoneInput, zoneLabel } from '../time';
import { adminApi } from './http';
import { doorsOpen, policyNarrowing } from './live-impact';
import { can } from './model';
import { useToast } from './toast';

interface Props {
  event: EventSummary;
  gates: Gate[];
  /** The event's devices: narrowing a policy's gates says which of them start refusing its passes. */
  scanners: Scanner[];
  policies: AdmissionPolicy[] | null;
  error: string;
  onChanged: () => Promise<void>;
}

export function PoliciesSection({ event, gates, scanners, policies, error: loadError, onChanged }: Props) {
  /** `null` = closed, `'new'` = create, otherwise the policy being edited. */
  const [editing, setEditing] = useState<AdmissionPolicy | 'new' | null>(null);
  const [error, setError] = useState('');
  /** Policy whose delete request is in flight; its button stays disabled so it cannot be sent twice. */
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const gateNames = new Map(gates.map((gate) => [gate.id, gate.name]));
  const editable = can(event, 'access') && event.status !== 'archived';
  const zone = event.timeZone;

  async function remove(policy: AdmissionPolicy) {
    if (policy.passCount > 0 || policy.admittedCount > 0) {
      // The server refuses these; say why up front instead of offering a delete that fails.
      await confirm({
        title: `“${policy.name}” cannot be deleted`,
        body: (
          <Consequences
            lead="A policy can only be deleted while no pass and no check-in uses it, so the admission history stays intact:"
            items={[
              ...(policy.passCount ? [`${policy.passCount} ${policy.passCount === 1 ? 'pass uses' : 'passes use'} it.`] : []),
              ...(policy.admittedCount ? [`${policy.admittedCount} ${policy.admittedCount === 1 ? 'person was' : 'people were'} admitted under it.`] : [])
            ]}
          >
            To stop using it, move its passes to another policy on the Passes tab; past admissions stay attached to it.
          </Consequences>
        ),
        confirmLabel: null
      });
      return;
    }
    const ok = await confirm({
      title: `Delete policy “${policy.name}”?`,
      body: 'No pass or check-in uses this policy. It disappears from the policy lists; this cannot be undone.',
      confirmLabel: 'Delete policy',
      danger: true
    });
    if (!ok) return;
    setError('');
    setDeleting(policy.id);
    try {
      await adminApi(`/api/policies/${policy.id}`, { method: 'DELETE' });
      await onChanged();
      notify(`Policy “${policy.name}” deleted`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="card" aria-labelledby="policies-title">
      <SectionHead
        id="policies-title"
        title="Admission policies"
        description={`Who may enter, where and when. Passes without a policy can enter at any gate while the event runs. Times in ${zoneLabel(zone, event.startsAt)}.`}
      >
        {editable ? (
          <button id="new-policy-button" className="btn btn-secondary" onClick={() => setEditing('new')}>
            <Plus size={16} aria-hidden /> New policy
          </button>
        ) : null}
      </SectionHead>
      <ErrorNote message={error || loadError} />
      {policies === null && !loadError ? (
        <p className="muted small" role="status">
          Loading policies…
        </p>
      ) : null}
      {policies?.length === 0 ? (
        <EmptyState title="No admission policies yet">Create one to give a group of passes its own entry window, gates or capacity, for example “Early entry” or “VIP”.</EmptyState>
      ) : null}
      {policies?.length ? (
        <div className="table-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Window</th>
                <th scope="col">Capacity</th>
                <th scope="col">Allowed gates</th>
                <th scope="col" className="num">
                  Passes
                </th>
                {editable ? (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td className="strong cell-primary">{policy.name}</td>
                  <td className="nowrap" data-label="Window">
                    {policy.opensAt ? formatShortInZone(policy.opensAt, zone) : 'Event start'} – {policy.closesAt ? formatShortInZone(policy.closesAt, zone) : 'Event end'}
                  </td>
                  <td className="capacity-cell" data-label="Capacity">
                    <CapacityLine admitted={policy.admittedCount} capacity={policy.capacity} />
                  </td>
                  <td data-label="Allowed gates">{policy.gateIds.length ? policy.gateIds.map((id) => gateNames.get(id) ?? 'Unknown gate').join(', ') : <span className="muted">Any gate</span>}</td>
                  <td className="num" data-label="Passes">
                    {policy.passCount}
                  </td>
                  {editable ? (
                    <td className="row-actions">
                      <button className="btn btn-ghost btn-small" onClick={() => setEditing(policy)} aria-label={`Edit policy ${policy.name}`}>
                        <Pencil size={14} aria-hidden /> Edit
                      </button>
                      <button className="btn btn-ghost btn-icon danger" onClick={() => void remove(policy)} disabled={deleting === policy.id} aria-label={`Delete policy ${policy.name}`} title="Delete">
                        <Trash2 size={14} aria-hidden />
                        <span className="row-action-text">Delete</span>
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing ? (
        <PolicyDialog
          event={event}
          gates={gates}
          scanners={scanners}
          policies={policies ?? []}
          policy={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      ) : null}
      {dialog}
    </section>
  );
}

interface DialogProps {
  event: EventSummary;
  gates: Gate[];
  scanners: Scanner[];
  /** Every policy of the event: their windows widen the time the doors are open. */
  policies: AdmissionPolicy[];
  policy: AdmissionPolicy | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

interface PolicyErrors {
  name?: string;
  opensAt?: string;
  closesAt?: string;
  capacity?: string;
}

function validatePolicy(name: string, opensAt: string, closesAt: string, opensIso: string | null, closesIso: string | null, capacity: string, admitted: number): PolicyErrors {
  const errors: PolicyErrors = {};
  if (!name.trim()) errors.name = 'Enter a name, for example VIP or Early entry.';
  if (opensAt && !opensIso) errors.opensAt = 'Enter a complete date and time, or leave it empty.';
  if (closesAt && !closesIso) errors.closesAt = 'Enter a complete date and time, or leave it empty.';
  else if (opensIso && closesIso && closesIso <= opensIso) errors.closesAt = 'Entry must close after it opens.';
  if (capacity.trim()) {
    const value = Number(capacity);
    if (!Number.isInteger(value) || value < 1) errors.capacity = 'Capacity must be a whole number of at least 1. Leave it empty for no limit.';
    else if (value < admitted) errors.capacity = `${admitted} people are already admitted, so capacity cannot be lower than ${admitted}.`;
  }
  return errors;
}

function PolicyDialog({ event, gates, scanners, policies, policy, onClose, onSaved }: DialogProps) {
  const zone = event.timeZone;
  const [name, setName] = useState(policy?.name ?? '');
  const [opensAt, setOpensAt] = useState(policy?.opensAt ? toZoneInput(policy.opensAt, zone) : '');
  const [closesAt, setClosesAt] = useState(policy?.closesAt ? toZoneInput(policy.closesAt, zone) : '');
  const [capacity, setCapacity] = useState(policy?.capacity ? String(policy.capacity) : '');
  const [gateIds, setGateIds] = useState<string[]>(policy?.gateIds ?? []);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const [confirm, dialog] = useConfirm();
  const admitted = policy?.admittedCount ?? 0;
  const opensIso = opensAt ? fromZoneInput(opensAt, zone) : null;
  const closesIso = closesAt ? fromZoneInput(closesAt, zone) : null;
  const check = () => validatePolicy(name, opensAt, closesAt, opensIso, closesIso, capacity, admitted);
  const errors = showErrors ? check() : {};
  const label = zoneLabel(zone, event.startsAt);

  function toggleGate(id: string, checked: boolean) {
    setGateIds((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(check()).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    const body = { name: name.trim(), opensAt: opensIso, closesAt: closesIso, capacity: capacity.trim() ? Number(capacity) : null, gateIds };
    // Narrowing a policy while the doors are open turns people away at once: say who, and have it acknowledged.
    const impact = policy && doorsOpen(event, policies) ? policyNarrowing(event, policy, body, gates, scanners, (iso) => formatTimeInZone(iso, zone)) : [];
    if (
      policy &&
      impact.length &&
      !(await confirm({
        title: `Change “${policy.name}” while the doors are open?`,
        body: (
          <Consequences lead="Scanners apply the change from their next scan:" items={impact}>
            People already admitted stay admitted.
          </Consequences>
        ),
        confirmLabel: 'Save and apply now',
        danger: true,
        acknowledge: 'I understand door staff will start refusing these passes.'
      }))
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (policy) await adminApi<AdmissionPolicy>(`/api/policies/${policy.id}`, { method: 'PATCH', body });
      else await adminApi<AdmissionPolicy>(`/api/events/${event.id}/policies`, { body });
      notify(policy ? `Policy “${body.name}” saved` : `Policy “${body.name}” created`);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={policy ? `Edit “${policy.name}”` : 'New admission policy'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit} noValidate>
        <label className="span-2">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            required
            placeholder="e.g. VIP, Early entry"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={describedBy(errors.name && 'policy-name-error')}
          />
          <FieldError id="policy-name-error" message={errors.name} />
        </label>
        <label>
          Entry opens
          <input
            type="datetime-local"
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
            aria-invalid={errors.opensAt ? true : undefined}
            aria-describedby={describedBy('policy-opens-hint', errors.opensAt && 'policy-opens-error')}
          />
          <span id="policy-opens-hint" className="field-hint">
            {label}. Empty: event start ({formatDateTimeInZone(event.startsAt, zone, false)})
          </span>
          <FieldError id="policy-opens-error" message={errors.opensAt} />
        </label>
        <label>
          Entry closes
          <input
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            aria-invalid={errors.closesAt ? true : undefined}
            aria-describedby={describedBy('policy-closes-hint', errors.closesAt && 'policy-closes-error')}
          />
          <span id="policy-closes-hint" className="field-hint">
            {label}. Empty: event end ({formatDateTimeInZone(event.endsAt, zone, false)})
          </span>
          <FieldError id="policy-closes-error" message={errors.closesAt} />
        </label>
        <label className="span-2">
          Capacity
          <input
            type="number"
            min={Math.max(1, admitted)}
            step={1}
            inputMode="numeric"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            aria-invalid={errors.capacity ? true : undefined}
            aria-describedby={describedBy('policy-capacity-hint', errors.capacity && 'policy-capacity-error')}
          />
          <span id="policy-capacity-hint" className="field-hint">
            Empty: no limit.{admitted ? ` ${admitted} already admitted, so it cannot be lower than that.` : ''}
          </span>
          <FieldError id="policy-capacity-error" message={errors.capacity} />
        </label>
        <fieldset className="span-2 checks">
          <legend>Allowed gates</legend>
          {gates.length === 0 ? (
            <p className="field-hint">No gates yet, so this policy allows every gate. Add gates above to restrict entry.</p>
          ) : (
            <>
              {gates.map((gate) => (
                <label key={gate.id} className="check">
                  <input type="checkbox" checked={gateIds.includes(gate.id)} onChange={(e) => toggleGate(gate.id, e.target.checked)} />
                  {gate.name}
                </label>
              ))}
              <p className="field-hint">None selected: any gate.</p>
            </>
          )}
        </fieldset>
        <ErrorNote message={error} />
        <div className="dialog-actions span-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : policy ? 'Save policy' : 'Create policy'}
          </button>
        </div>
      </form>
      {dialog}
    </Modal>
  );
}
