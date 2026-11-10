import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, Gate } from '../../shared/types';
import { Modal, useConfirm } from '../dialog';
import { ErrorNote, SectionHead, errorMessage } from '../ui';
import { useResource } from './hooks';
import { adminApi } from './http';
import { ARCHIVED_NOTE, can } from './model';
import { PoliciesSection } from './PoliciesSection';
import { ScannersSection } from './ScannersSection';
import { useToast } from './toast';

/** Where and when passes are accepted: gates, admission policies and the door devices bound to gates. */
export function AccessPanel({ event, onChanged }: { event: EventSummary; onChanged: () => Promise<void> }) {
  const gates = useResource<Gate[]>(`/api/events/${event.id}/gates`);
  const policies = useResource<AdmissionPolicy[]>(`/api/events/${event.id}/policies`);

  // Gate, policy and device changes also refresh the event, which drives the setup checklist.
  async function gatesChanged() {
    await Promise.all([gates.reload(), policies.reload(), onChanged()]);
  }
  async function policiesChanged() {
    await Promise.all([policies.reload(), onChanged()]);
  }

  return (
    <div className="stack-lg">
      {event.status === 'archived' ? <p className="notice">{ARCHIVED_NOTE}</p> : null}
      <GatesSection event={event} gates={gates.data} error={gates.error} onChanged={gatesChanged} />
      <PoliciesSection event={event} gates={gates.data ?? []} policies={policies.data} error={policies.error} onChanged={policiesChanged} />
      <ScannersSection event={event} gates={gates.data ?? []} onChanged={onChanged} />
    </div>
  );
}

interface GatesProps {
  event: EventSummary;
  gates: Gate[] | null;
  error: string;
  onChanged: () => Promise<void>;
}

function GatesSection({ event, gates, error: loadError, onChanged }: GatesProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<Gate | null>(null);
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const editable = can(event, 'access') && event.status !== 'archived';

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const gate = await adminApi<Gate>(`/api/events/${event.id}/gates`, { body: { name: name.trim() } });
      setName('');
      await onChanged();
      notify(`Gate “${gate.name}” added`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(gate: Gate) {
    const ok = await confirm({
      title: `Delete gate “${gate.name}”?`,
      body: 'Only a gate that no device, policy or past check-in uses can be deleted. To stop using a gate that has history, rebind its devices and remove it from policies instead.',
      confirmLabel: 'Delete gate',
      danger: true
    });
    if (!ok) return;
    setError('');
    try {
      await adminApi(`/api/gates/${gate.id}`, { method: 'DELETE' });
      await onChanged();
      notify(`Gate “${gate.name}” deleted`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card" aria-labelledby="gates-title">
      <SectionHead id="gates-title" title="Gates" description="Physical entrances. Bind scanner devices to a gate and limit policies to specific gates." />
      <div className="gate-row">
        {gates?.length ? (
          <ul className="chips" aria-label="Gates">
            {gates.map((gate) => (
              <li key={gate.id} className="chip">
                <span>{gate.name}</span>
                <span className="chip-count num" title={`${gate.admittedCount} admitted`}>
                  {gate.admittedCount}
                  <span className="sr-only"> admitted</span>
                </span>
                {editable ? (
                  <span className="chip-actions">
                    <button type="button" className="btn btn-ghost btn-icon chip-btn" onClick={() => setRenaming(gate)} aria-label={`Rename gate ${gate.name}`} title="Rename">
                      <Pencil size={13} aria-hidden />
                    </button>
                    <button type="button" className="btn btn-ghost btn-icon chip-btn danger" onClick={() => void remove(gate)} aria-label={`Delete gate ${gate.name}`} title="Delete">
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {editable ? (
          <form className="inline-form gate-form" onSubmit={create}>
            <label className="grow">
              <span className="sr-only">Gate name</span>
              <input id="gate-name-input" placeholder="Gate name, e.g. North entrance" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
            </label>
            <button className="btn btn-secondary" disabled={busy || !name.trim()}>
              <Plus size={16} aria-hidden /> {busy ? 'Adding…' : 'Add gate'}
            </button>
          </form>
        ) : null}
      </div>
      {gates === null && !loadError ? (
        <p className="muted small" role="status">
          Loading gates…
        </p>
      ) : null}
      {gates?.length === 0 ? <p className="muted small">No gates yet. Without gates every device scans for the whole venue; add one per entrance to track and restrict entry by gate.</p> : null}
      <ErrorNote message={error || loadError} />
      {renaming ? (
        <RenameGateDialog
          gate={renaming}
          onClose={() => setRenaming(null)}
          onSaved={async (gate) => {
            setRenaming(null);
            await onChanged();
            notify(`Gate renamed to “${gate.name}”`);
          }}
        />
      ) : null}
      {dialog}
    </section>
  );
}

function RenameGateDialog({ gate, onClose, onSaved }: { gate: Gate; onClose: () => void; onSaved: (gate: Gate) => Promise<void> }) {
  const [name, setName] = useState(gate.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSaved(await adminApi<Gate>(`/api/gates/${gate.id}`, { method: 'PATCH', body: { name: name.trim() } }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Rename “${gate.name}”`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>
          Gate name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </label>
        <p className="muted small">Devices, policies and reports show the new name; past check-ins stay attached to this gate.</p>
        <ErrorNote message={error} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || name.trim() === gate.name}>
            {busy ? 'Saving…' : 'Rename gate'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
