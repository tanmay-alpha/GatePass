import { Pencil, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, Gate } from '../../shared/types';
import { api, formatDateTime, fromLocalInput, toLocalInput } from '../api';
import { Modal } from '../dialog';
import { CapacityLine, EmptyState, ErrorNote, SectionHead, errorMessage } from '../ui';
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
        <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={event.status !== 'active'}>
          <Plus size={16} aria-hidden /> New policy
        </button>
      </SectionHead>
      <ErrorNote message={error} />
      {policies === null && !error ? <p className="muted small" role="status">Loading policies…</p> : null}
      {policies?.length === 0 ? (
        <EmptyState title="No admission policies yet">Create one to give a group of passes its own entry window, gates or capacity, for example “Early entry” or “VIP”.</EmptyState>
      ) : null}
      {policies?.length ? (
        <ul className="policy-list">
          {policies.map((policy) => (
            <li key={policy.id} className="policy-item">
              <div className="policy-main">
                <div className="policy-name">{policy.name}</div>
                <dl className="policy-facts small">
                  <div>
                    <dt>Window</dt>
                    <dd>
                      {policy.opensAt ? formatDateTime(policy.opensAt) : 'Event start'} – {policy.closesAt ? formatDateTime(policy.closesAt) : 'Event end'}
                    </dd>
                  </div>
                  <div>
                    <dt>Gates</dt>
                    <dd>{policy.gateIds.length ? policy.gateIds.map((id) => gateNames.get(id) ?? 'Unknown gate').join(', ') : 'Any gate'}</dd>
                  </div>
                  <div>
                    <dt>Passes</dt>
                    <dd className="num">{policy.passCount}</dd>
                  </div>
                </dl>
                <CapacityLine admitted={policy.admittedCount} capacity={policy.capacity} />
              </div>
              <button className="btn btn-secondary btn-small" onClick={() => setEditing(policy)} aria-label={`Edit policy ${policy.name}`}>
                <Pencil size={14} aria-hidden /> Edit
              </button>
            </li>
          ))}
        </ul>
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

function PolicyDialog({ token, event, gates, policy, onClose, onSaved }: DialogProps) {
  const [name, setName] = useState(policy?.name ?? '');
  const [opensAt, setOpensAt] = useState(policy?.opensAt ? toLocalInput(policy.opensAt) : '');
  const [closesAt, setClosesAt] = useState(policy?.closesAt ? toLocalInput(policy.closesAt) : '');
  const [capacity, setCapacity] = useState(policy?.capacity ? String(policy.capacity) : '');
  const [gateIds, setGateIds] = useState<string[]>(policy?.gateIds ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const notify = useToast();

  function toggleGate(id: string, checked: boolean) {
    setGateIds((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) {
      setError('Entry must close after it opens.');
      return;
    }
    setBusy(true);
    setError('');
    const body = {
      name: name.trim(),
      opensAt: opensAt ? fromLocalInput(opensAt) : null,
      closesAt: closesAt ? fromLocalInput(closesAt) : null,
      capacity: capacity ? Number(capacity) : null,
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
      <form className="form-grid" onSubmit={submit}>
        <label className="span-2">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required placeholder="e.g. VIP, Early entry" />
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
          <input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} aria-describedby="policy-closes-hint" />
          <span id="policy-closes-hint" className="field-hint">
            Empty: event end ({formatDateTime(event.endsAt)})
          </span>
        </label>
        <label className="span-2">
          Capacity
          <input
            type="number"
            min={Math.max(1, policy?.admittedCount ?? 1)}
            step={1}
            inputMode="numeric"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            aria-describedby="policy-capacity-hint"
          />
          <span id="policy-capacity-hint" className="field-hint">
            Empty: no limit.{policy?.admittedCount ? ` ${policy.admittedCount} already admitted, so it cannot be lower than that.` : ''}
          </span>
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
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : policy ? 'Save policy' : 'Create policy'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
