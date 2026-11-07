import { Pencil, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, Gate } from '../../shared/types';
import { api, formatDateTime, formatTime, fromLocalInput, toLocalInput } from '../api';
import { Modal } from '../dialog';
import { CapacityLine, EmptyState, ErrorNote, FieldError, SectionHead, errorMessage, focusFirstInvalid } from '../ui';
import { useToast } from './toast';

interface Props {
  token: string;
  event: EventSummary;
  gates: Gate[];
  policies: AdmissionPolicy[] | null;
  error: string;
  onChanged: () => Promise<void>;
}

export function PoliciesSection({ token, event, gates, policies, error, onChanged }: Props) {
  /** `null` = closed, `'new'` = create, otherwise the policy being edited. */
  const [editing, setEditing] = useState<AdmissionPolicy | 'new' | null>(null);
  const gateNames = new Map(gates.map((gate) => [gate.id, gate.name]));

  return (
    <section className="card" aria-labelledby="policies-title">
      <SectionHead
        id="policies-title"
        title="Admission policies"
        description="Who may enter, where and when. Passes without a policy can enter at any gate while the event runs."
      >
        <button id="new-policy-button" className="btn btn-secondary" onClick={() => setEditing('new')} disabled={event.status !== 'active'}>
          <Plus size={16} aria-hidden /> New policy
        </button>
      </SectionHead>
      <ErrorNote message={error} />
      {policies === null && !error ? <p className="muted small" role="status">Loading policies…</p> : null}
      {policies?.length === 0 ? (
        <EmptyState title="No admission policies yet">Create one to give a group of passes its own entry window, gates or capacity, for example “Early entry” or “VIP”.</EmptyState>
      ) : null}
      {policies?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Window</th>
                <th scope="col">Capacity</th>
                <th scope="col">Allowed gates</th>
                <th scope="col" className="num">
                  Passes
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td className="strong">{policy.name}</td>
                  <td className="num nowrap">
                    {policy.opensAt ? formatTime(policy.opensAt) : 'Event start'} – {policy.closesAt ? formatTime(policy.closesAt) : 'Event end'}
                  </td>
                  <td className="capacity-cell">
                    <CapacityLine admitted={policy.admittedCount} capacity={policy.capacity} />
                  </td>
                  <td>{policy.gateIds.length ? policy.gateIds.map((id) => gateNames.get(id) ?? 'Unknown gate').join(', ') : <span className="muted">Any gate</span>}</td>
                  <td className="num">{policy.passCount}</td>
                  <td className="row-actions">
                    <button className="btn btn-ghost btn-small" onClick={() => setEditing(policy)} aria-label={`Edit policy ${policy.name}`}>
                      <Pencil size={14} aria-hidden /> Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing ? (
        <PolicyDialog
          token={token}
          event={event}
          gates={gates}
          policy={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

interface DialogProps {
  token: string;
  event: EventSummary;
  gates: Gate[];
  policy: AdmissionPolicy | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

interface PolicyErrors {
  name?: string;
  closesAt?: string;
  capacity?: string;
}

function validatePolicy(name: string, opensAt: string, closesAt: string, capacity: string, admitted: number): PolicyErrors {
  const errors: PolicyErrors = {};
  if (!name.trim()) errors.name = 'Enter a name, for example VIP or Early entry.';
  if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) errors.closesAt = 'Entry must close after it opens.';
  if (capacity.trim()) {
    const value = Number(capacity);
    if (!Number.isInteger(value) || value < 1) errors.capacity = 'Capacity must be a whole number of at least 1. Leave it empty for no limit.';
    else if (value < admitted) errors.capacity = `${admitted} people are already admitted, so capacity cannot be lower than ${admitted}.`;
  }
  return errors;
}

function PolicyDialog({ token, event, gates, policy, onClose, onSaved }: DialogProps) {
  const [name, setName] = useState(policy?.name ?? '');
  const [opensAt, setOpensAt] = useState(policy?.opensAt ? toLocalInput(policy.opensAt) : '');
  const [closesAt, setClosesAt] = useState(policy?.closesAt ? toLocalInput(policy.closesAt) : '');
  const [capacity, setCapacity] = useState(policy?.capacity ? String(policy.capacity) : '');
  const [gateIds, setGateIds] = useState<string[]>(policy?.gateIds ?? []);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const admitted = policy?.admittedCount ?? 0;
  const errors = showErrors ? validatePolicy(name, opensAt, closesAt, capacity, admitted) : {};
  const [busy, setBusy] = useState(false);
  const notify = useToast();

  function toggleGate(id: string, checked: boolean) {
    setGateIds((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (Object.keys(validatePolicy(name, opensAt, closesAt, capacity, admitted)).length) {
      setShowErrors(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setBusy(true);
    setError('');
    const body = {
      name: name.trim(),
      opensAt: opensAt ? fromLocalInput(opensAt) : null,
      closesAt: closesAt ? fromLocalInput(closesAt) : null,
      capacity: capacity.trim() ? Number(capacity) : null,
      gateIds
    };
    try {
      if (policy) await api<AdmissionPolicy>(`/api/policies/${policy.id}`, token, { method: 'PATCH', body });
      else await api<AdmissionPolicy>(`/api/events/${event.id}/policies`, token, { body });
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
            aria-describedby="policy-name-error"
          />
          <FieldError id="policy-name-error" message={errors.name} />
        </label>
        <label>
          Entry opens
          <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} aria-describedby="policy-opens-hint" />
          <span id="policy-opens-hint" className="field-hint">
            Empty: event start ({formatDateTime(event.startsAt)})
          </span>
        </label>
        <label>
          Entry closes
          <input
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            aria-invalid={errors.closesAt ? true : undefined}
            aria-describedby="policy-closes-hint policy-closes-error"
          />
          <span id="policy-closes-hint" className="field-hint">
            Empty: event end ({formatDateTime(event.endsAt)})
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
            aria-describedby="policy-capacity-hint policy-capacity-error"
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
    </Modal>
  );
}
