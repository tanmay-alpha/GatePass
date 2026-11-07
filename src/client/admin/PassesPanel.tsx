import { Ban, RefreshCw, Shuffle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, IssuedPass, Pass, PassStatus } from '../../shared/types';
import { api, formatDateTime } from '../api';
import { Modal, useConfirm } from '../dialog';
import { Badge, ErrorNote, TableMessage, errorMessage } from '../ui';
import { useDebounced, useResource } from './hooks';
import { IssuedPasses } from './IssuedPasses';
import { IssueForm } from './IssueForm';
import { useToast } from './toast';

interface Props {
  token: string;
  event: EventSummary;
  onChanged: () => Promise<void>;
}

function describePass(pass: Pass): string {
  return pass.attendeeName || pass.attendeeEmail || `pass ${pass.id.slice(0, 8)}`;
}

export function PassesPanel({ token, event, onChanged }: Props) {
  const [status, setStatus] = useState<PassStatus | ''>('');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query.trim(), 200);
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (debouncedQuery) params.set('q', debouncedQuery);
  const passes = useResource<Pass[]>(`/api/events/${event.id}/passes?${params}`, token);
  const policies = useResource<AdmissionPolicy[]>(`/api/events/${event.id}/policies`, token);
  const [issued, setIssued] = useState<IssuedPass[]>([]);
  const [changing, setChanging] = useState<Pass | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const policyNames = new Map(policies.data?.map((policy) => [policy.id, policy.name]));
  const filtered = Boolean(status || debouncedQuery);

  async function act(pass: Pass, action: 'revoke' | 'reissue') {
    const who = describePass(pass);
    const ok = await confirm(
      action === 'revoke'
        ? {
            title: `Revoke the pass for ${who}?`,
            body: 'Scanners will reject this pass from now on. This cannot be undone; issue a new pass if it was a mistake.',
            confirmLabel: 'Revoke pass',
            danger: true
          }
        : {
            title: `Reissue the pass for ${who}?`,
            body: 'A new QR code and link are created and the current code stops working immediately. Send the new code to the attendee.',
            confirmLabel: 'Reissue pass'
          }
    );
    if (!ok) return;
    setPending(pass.id);
    setError('');
    try {
      const result = await api<Pass | IssuedPass>(`/api/passes/${pass.id}/${action}`, token, { method: 'POST' });
      if ('token' in result) setIssued([result]);
      await Promise.all([passes.reload(), onChanged()]);
      notify(action === 'revoke' ? `Pass for ${who} revoked` : `New code issued for ${who}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="stack-lg">
      {event.status === 'active' ? (
        <IssueForm
          token={token}
          event={event}
          policies={policies.data ?? []}
          onIssued={async (result) => {
            setIssued(result);
            await Promise.all([passes.reload(), policies.reload(), onChanged()]);
            notify(`${result.length} pass${result.length === 1 ? '' : 'es'} issued`);
          }}
        />
      ) : (
        <p className="notice">This event is archived; no new passes can be issued. Reopen it in Settings to issue passes.</p>
      )}

      {issued.length > 0 ? <IssuedPasses token={token} event={event} passes={issued} policyNames={policyNames} onClose={() => setIssued([])} /> : null}

      <section className="card stack" aria-label="Passes">
        <div className="toolbar">
          <label className="grow">
            <span className="sr-only">Search passes</span>
            <input type="search" placeholder="Search name, email or pass ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label>
            <span className="sr-only">Filter by status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as PassStatus | '')}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="redeemed">Redeemed</option>
              <option value="revoked">Revoked</option>
              <option value="expired">Expired</option>
            </select>
          </label>
        </div>
        <ErrorNote message={error || passes.error || policies.error} />

        <div className="table-wrap">
          <table aria-busy={passes.loading}>
            <thead>
              <tr>
                <th scope="col">Attendee</th>
                <th scope="col">Status</th>
                <th scope="col">Policy</th>
                <th scope="col">Expires</th>
                <th scope="col">Checked in</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {passes.data?.map((pass) => (
                <tr key={pass.id}>
                  <td>
                    <div>{pass.attendeeName || <span className="muted">Unnamed</span>}</div>
                    <div className="muted small">{pass.attendeeEmail || <code>{pass.id.slice(0, 8)}</code>}</div>
                  </td>
                  <td>
                    <Badge value={pass.status} />
                  </td>
                  <td className="small">{pass.policyId ? (policyNames.get(pass.policyId) ?? '…') : <span className="muted">None</span>}</td>
                  <td className="small">{formatDateTime(pass.expiresAt)}</td>
                  <td className="small">{formatDateTime(pass.redeemedAt)}</td>
                  <td className="row-actions">
                    {pass.status === 'active' ? (
                      <>
                        <button className="btn btn-ghost btn-small" onClick={() => setChanging(pass)} disabled={pending === pass.id} aria-label={`Change policy for ${describePass(pass)}`}>
                          <Shuffle size={14} aria-hidden /> Change policy
                        </button>
                        <button className="btn btn-ghost btn-small" onClick={() => void act(pass, 'reissue')} disabled={pending === pass.id} aria-label={`Reissue pass for ${describePass(pass)}`}>
                          <RefreshCw size={14} aria-hidden /> Reissue
                        </button>
                      </>
                    ) : null}
                    {pass.status === 'active' || pass.status === 'expired' ? (
                      <button className="btn btn-ghost btn-small danger" onClick={() => void act(pass, 'revoke')} disabled={pending === pass.id} aria-label={`Revoke pass for ${describePass(pass)}`}>
                        <Ban size={14} aria-hidden /> {pending === pass.id ? 'Working…' : 'Revoke'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {passes.data === null && !passes.error ? <TableMessage colSpan={6}>Loading passes…</TableMessage> : null}
              {passes.data?.length === 0 ? (
                <TableMessage colSpan={6}>
                  {filtered ? 'No passes match this search or filter.' : event.status === 'active' ? 'No passes yet. Use “Issue passes” above to create the first ones.' : 'No passes were issued for this event.'}
                </TableMessage>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      {changing ? (
        <ChangePolicyDialog
          token={token}
          pass={changing}
          policies={policies.data ?? []}
          onClose={() => setChanging(null)}
          onSaved={async (name) => {
            setChanging(null);
            await Promise.all([passes.reload(), policies.reload()]);
            notify(`${describePass(changing)} now uses ${name}`);
          }}
        />
      ) : null}
      {dialog}
    </div>
  );
}

interface ChangePolicyProps {
  token: string;
  pass: Pass;
  policies: AdmissionPolicy[];
  onClose: () => void;
  onSaved: (policyName: string) => Promise<void>;
}

function ChangePolicyDialog({ token, pass, policies, onClose, onSaved }: ChangePolicyProps) {
  const [policyId, setPolicyId] = useState(pass.policyId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = policies.find((policy) => policy.id === policyId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api<Pass>(`/api/passes/${pass.id}`, token, { method: 'PATCH', body: { policyId: policyId || null } });
      await onSaved(selected ? `“${selected.name}”` : 'no policy');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Change policy for ${describePass(pass)}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">The pass keeps its QR code. The next scan is checked against the new policy's gates, entry window and capacity.</p>
        <label>
          Admission policy
          <select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
            <option value="">No policy (any gate, during the event)</option>
            {policies.map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.capacity === null ? policy.name : `${policy.name} (${policy.admittedCount}/${policy.capacity} admitted)`}
              </option>
            ))}
          </select>
        </label>
        <ErrorNote message={error} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || policyId === (pass.policyId ?? '')}>
            {busy ? 'Saving…' : 'Change policy'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
