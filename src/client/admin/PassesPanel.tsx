import { Ban, ChevronLeft, ChevronRight, Download, FileUp, RefreshCw, Search, Shuffle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AdmissionPolicy, EventSummary, IssuedPass, Pass, PassStatus } from '../../shared/types';
import { Modal, useConfirm } from '../dialog';
import { ErrorNote, PassStatusBadge, TableMessage, errorMessage } from '../ui';
import { formatShortInZone, zoneLabel } from '../time';
import { useDebounced, useResource } from './hooks';
import { adminApi, adminDownload, fetchPage, type Page } from './http';
import { ImportPasses } from './ImportPasses';
import { IssuedPasses, passReference } from './IssuedPasses';
import { IssueForm } from './IssueForm';
import { ARCHIVED_NOTE, ISSUE_BLOCKED, can, issuesPasses } from './model';
import { useToast } from './toast';

const PAGE_SIZE = 50;
/** The bulk revoke endpoint accepts at most this many ids per request. */
const BULK_LIMIT = 500;

interface Props {
  event: EventSummary;
  onChanged: () => Promise<void>;
}

function describePass(pass: Pass): string {
  return pass.attendeeName || pass.attendeeEmail || `pass ${passReference(pass.id)}`;
}

const revocable = (pass: Pass) => pass.status === 'active' || pass.status === 'expired';

export function PassesPanel({ event, onChanged }: Props) {
  const [status, setStatus] = useState<PassStatus | ''>('');
  const [policyFilter, setPolicyFilter] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const debouncedQuery = useDebounced(query.trim(), 200);
  const policies = useResource<AdmissionPolicy[]>(`/api/events/${event.id}/policies`);
  const [page, setPage] = useState<Page<Pass> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [issued, setIssued] = useState<IssuedPass[]>([]);
  const [changing, setChanging] = useState<Pass | null>(null);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [confirm, dialog] = useConfirm();
  const notify = useToast();
  const latest = useRef(0);
  const policyNames = new Map(policies.data?.map((policy) => [policy.id, policy.name]));
  const filtered = Boolean(status || debouncedQuery || policyFilter);
  const managePasses = can(event, 'passes') && event.status !== 'archived';
  const canIssue = can(event, 'passes') && issuesPasses(event);
  const zone = event.timeZone;

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (status) params.set('status', status);
  if (debouncedQuery) params.set('q', debouncedQuery);
  if (policyFilter) params.set('policyId', policyFilter);
  const path = `/api/events/${event.id}/passes?${params}`;

  const reload = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const result = await fetchPage<Pass>(path);
      if (request !== latest.current) return;
      setPage(result);
      setLoadError('');
    } catch (err) {
      if (request === latest.current) setLoadError(errorMessage(err));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A new filter starts from the first page and drops a selection the user can no longer see.
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [status, debouncedQuery, policyFilter]);

  const rows = page?.items ?? [];
  const selectable = rows.filter(revocable);
  const allSelected = selectable.length > 0 && selectable.every((pass) => selected.has(pass.id));
  const total = page?.total ?? 0;

  function toggle(passId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(passId);
      else next.delete(passId);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const pass of selectable) {
        if (checked) next.add(pass.id);
        else next.delete(pass.id);
      }
      return next;
    });
  }

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
      const result = await adminApi<Pass | IssuedPass>(`/api/passes/${pass.id}/${action}`, { method: 'POST' });
      if ('token' in result) setIssued([result]);
      await Promise.all([reload(), onChanged()]);
      notify(action === 'revoke' ? `Pass for ${who} revoked` : `New code issued for ${who}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function revokeSelected() {
    const ids = [...selected];
    const ok = await confirm({
      title: `Revoke ${ids.length} pass${ids.length === 1 ? '' : 'es'}?`,
      body: 'Scanners will reject these passes from now on. This cannot be undone; already used and already revoked passes are skipped.',
      confirmLabel: `Revoke ${ids.length} pass${ids.length === 1 ? '' : 'es'}`,
      danger: true
    });
    if (!ok) return;
    setPending('bulk');
    setError('');
    try {
      let revoked = 0;
      let skipped = 0;
      for (let start = 0; start < ids.length; start += BULK_LIMIT) {
        const result = await adminApi<{ revoked: number; skipped: number }>(`/api/events/${event.id}/passes/revoke`, { body: { passIds: ids.slice(start, start + BULK_LIMIT) } });
        revoked += result.revoked;
        skipped += result.skipped;
      }
      setSelected(new Set());
      await Promise.all([reload(), onChanged()]);
      notify(`${revoked} pass${revoked === 1 ? '' : 'es'} revoked${skipped ? `, ${skipped} skipped` : ''}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function exportAttendance() {
    setExporting(true);
    setError('');
    try {
      await adminDownload(`/api/events/${event.id}/exports/attendance.csv`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function afterIssue(result: IssuedPass[], message: string) {
    setIssued(result);
    await Promise.all([reload(), policies.reload(), onChanged()]);
    notify(message);
  }

  const columns = managePasses ? 7 : 6;

  return (
    <div className="stack-lg">
      {issued.length > 0 ? <IssuedPasses event={event} passes={issued} policyNames={policyNames} onClose={() => setIssued([])} /> : null}

      <div className={canIssue ? 'passes-layout' : undefined}>
        {canIssue ? (
          <IssueForm event={event} policies={policies.data ?? []} onIssued={(result) => afterIssue(result, `${result.length} pass${result.length === 1 ? '' : 'es'} issued`)} />
        ) : !can(event, 'passes') ? null : event.status === 'archived' ? (
          <p className="notice">{ARCHIVED_NOTE}</p>
        ) : (
          <p className="notice">{ISSUE_BLOCKED[event.status]}</p>
        )}

        <section className="card" aria-label="Passes">
          <div className="toolbar">
            <label className="grow search">
              <span className="sr-only">Search passes</span>
              <Search size={15} className="search-icon" aria-hidden />
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
            <label>
              <span className="sr-only">Filter by policy</span>
              <select value={policyFilter} onChange={(e) => setPolicyFilter(e.target.value)}>
                <option value="">All policies</option>
                {policies.data?.map((policy) => (
                  <option key={policy.id} value={policy.id}>
                    {policy.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="pass-actions">
            {selected.size > 0 ? (
              <>
                <span className="small strong" role="status">
                  {selected.size} selected
                </span>
                <button type="button" className="btn btn-secondary btn-small danger" onClick={() => void revokeSelected()} disabled={pending === 'bulk'}>
                  <Ban size={14} aria-hidden /> {pending === 'bulk' ? 'Revoking…' : 'Revoke selected'}
                </button>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              </>
            ) : (
              <span className="muted small num">{page ? `${total} pass${total === 1 ? '' : 'es'}${filtered ? ' match' : ''}` : ''}</span>
            )}
            <span className="pass-actions-end actions">
              {canIssue ? (
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setImporting(true)}>
                  <FileUp size={14} aria-hidden /> Import CSV
                </button>
              ) : null}
              {can(event, 'export') ? (
                <button type="button" className="btn btn-secondary btn-small" onClick={() => void exportAttendance()} disabled={exporting}>
                  <Download size={14} aria-hidden /> {exporting ? 'Exporting…' : 'Export attendance CSV'}
                </button>
              ) : null}
            </span>
          </div>
          <ErrorNote message={error || loadError || policies.error} />
          {loadError ? (
            <div className="actions">
              <button type="button" className="btn btn-secondary btn-small" onClick={() => void reload()}>
                Retry
              </button>
            </div>
          ) : null}

          <div className="table-wrap">
            <table aria-busy={loading}>
              <thead>
                <tr>
                  {managePasses ? (
                    <th scope="col" className="check-cell">
                      <input type="checkbox" checked={allSelected} disabled={selectable.length === 0} onChange={(e) => toggleAll(e.target.checked)} aria-label="Select all revocable passes on this page" />
                    </th>
                  ) : null}
                  <th scope="col">Attendee</th>
                  <th scope="col">Status</th>
                  <th scope="col">Policy</th>
                  <th scope="col">Expires ({zoneLabel(zone, event.startsAt)})</th>
                  <th scope="col">Checked in</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((pass) => (
                  <tr key={pass.id}>
                    {managePasses ? (
                      <td className="check-cell">
                        {revocable(pass) ? (
                          <input type="checkbox" checked={selected.has(pass.id)} onChange={(e) => toggle(pass.id, e.target.checked)} aria-label={`Select ${describePass(pass)}`} />
                        ) : null}
                      </td>
                    ) : null}
                    <td>
                      <div className="strong">{pass.attendeeName || <span className="muted">Unnamed</span>}</div>
                      <div className="muted small">
                        {pass.attendeeEmail ? `${pass.attendeeEmail} · ` : ''}
                        <code>{passReference(pass.id)}</code>
                      </div>
                    </td>
                    <td>
                      <PassStatusBadge status={pass.status} />
                    </td>
                    <td>{pass.policyId ? (policyNames.get(pass.policyId) ?? '…') : <span className="muted">None</span>}</td>
                    <td className="num muted nowrap">{formatShortInZone(pass.expiresAt, zone)}</td>
                    <td className="num muted nowrap">{formatShortInZone(pass.redeemedAt, zone)}</td>
                    <td className="row-actions">
                      {managePasses && pass.status === 'active' ? (
                        <>
                          <button
                            className="btn btn-ghost btn-icon"
                            onClick={() => setChanging(pass)}
                            disabled={pending === pass.id}
                            aria-label={`Change policy for ${describePass(pass)}`}
                            title="Change policy"
                          >
                            <Shuffle size={15} aria-hidden />
                          </button>
                          <button
                            className="btn btn-ghost btn-icon"
                            onClick={() => void act(pass, 'reissue')}
                            disabled={pending === pass.id}
                            aria-label={`Reissue pass for ${describePass(pass)}`}
                            title="Reissue"
                          >
                            <RefreshCw size={15} aria-hidden />
                          </button>
                        </>
                      ) : null}
                      {managePasses && revocable(pass) ? (
                        <button
                          className="btn btn-ghost btn-icon danger"
                          onClick={() => void act(pass, 'revoke')}
                          disabled={pending === pass.id}
                          aria-label={`Revoke pass for ${describePass(pass)}`}
                          title="Revoke"
                        >
                          <Ban size={15} aria-hidden />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {page === null && !loadError ? <TableMessage colSpan={columns}>Loading passes…</TableMessage> : null}
                {page?.items.length === 0 ? (
                  <TableMessage colSpan={columns}>
                    {filtered
                      ? 'No passes match this search or filter.'
                      : canIssue
                        ? 'No passes yet. Use “Issue passes” or “Import CSV” to create the first ones.'
                        : 'No passes were issued for this event.'}
                  </TableMessage>
                ) : null}
              </tbody>
            </table>
          </div>
          {page && total > PAGE_SIZE ? (
            <nav className="pager" aria-label="Pass pages">
              <span className="muted small num">
                {Math.min(offset + 1, total)}–{Math.min(offset + rows.length, total)} of {total}
              </span>
              <span className="actions">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>
                  <ChevronLeft size={14} aria-hidden /> Previous
                </button>
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading}>
                  Next <ChevronRight size={14} aria-hidden />
                </button>
              </span>
            </nav>
          ) : null}
        </section>
      </div>
      {changing ? (
        <ChangePolicyDialog
          pass={changing}
          policies={policies.data ?? []}
          onClose={() => setChanging(null)}
          onSaved={async (name) => {
            setChanging(null);
            await Promise.all([reload(), policies.reload()]);
            notify(`${describePass(changing)} now uses ${name}`);
          }}
        />
      ) : null}
      {importing ? (
        <ImportPasses
          event={event}
          policies={policies.data ?? []}
          onClose={() => setImporting(false)}
          onImported={async (result, skipped) => {
            setImporting(false);
            await afterIssue(result, `${result.length} pass${result.length === 1 ? '' : 'es'} imported${skipped ? `, ${skipped} row${skipped === 1 ? '' : 's'} skipped` : ''}`);
          }}
        />
      ) : null}
      {dialog}
    </div>
  );
}

interface ChangePolicyProps {
  pass: Pass;
  policies: AdmissionPolicy[];
  onClose: () => void;
  onSaved: (policyName: string) => Promise<void>;
}

function ChangePolicyDialog({ pass, policies, onClose, onSaved }: ChangePolicyProps) {
  const [policyId, setPolicyId] = useState(pass.policyId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = policies.find((policy) => policy.id === policyId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminApi<Pass>(`/api/passes/${pass.id}`, { method: 'PATCH', body: { policyId: policyId || null } });
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
