import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/client/api';
import { explain, explainFailure, formatEventTime, isScanResult, verdictOf } from '../src/client/scanner/outcome';
import { REPEAT_SUPPRESS_MS, RepeatFilter } from '../src/client/scanner/repeat';
import { PendingScans, RETRY_WINDOW_MS, isUnanswered, newRequestId } from '../src/client/scanner/retry';
import type { ScanOutcome, ScanResult } from '../src/shared/types';

const CODE = 'https://gatepass.example/p/' + 'A'.repeat(43);

describe('scan requestIds', () => {
  it('match the server rule and are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, newRequestId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('only timeouts and network failures count as unanswered', () => {
    expect(isUnanswered(new ApiError(0, 'timeout', null, 'timeout'))).toBe(true);
    expect(isUnanswered(new ApiError(0, 'network', null, 'network'))).toBe(true);
    expect(isUnanswered(new ApiError(500, 'Server error'))).toBe(false);
    expect(isUnanswered(new ApiError(429, 'Too many', 5))).toBe(false);
    expect(isUnanswered(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('PendingScans', () => {
  it('reuses the requestId of an unanswered scan of the same code, then starts fresh once answered', () => {
    let n = 0;
    const pending = new PendingScans(RETRY_WINDOW_MS, () => `request-${++n}`);
    const first = pending.requestIdFor(CODE, 0);
    expect(first).toBe('request-1');
    // Timed out: remembered.
    pending.remember(CODE, first, 1_000);
    expect(pending.requestIdFor(CODE, 30_000)).toBe(first);
    // A different code is unaffected.
    expect(pending.requestIdFor('other', 30_000)).toBe('request-2');
    // The retry got an answer (possibly replayed): forget it; the next scan is a new attempt.
    pending.forget(CODE);
    expect(pending.requestIdFor(CODE, 31_000)).toBe('request-3');
  });

  it('forgets unanswered scans after two minutes', () => {
    let n = 0;
    const pending = new PendingScans(RETRY_WINDOW_MS, () => `request-${++n}`);
    const id = pending.requestIdFor(CODE, 0);
    pending.remember(CODE, id, 0);
    expect(pending.has(CODE, RETRY_WINDOW_MS - 1)).toBe(true);
    expect(pending.requestIdFor(CODE, RETRY_WINDOW_MS - 1)).toBe(id);
    expect(pending.has(CODE, RETRY_WINDOW_MS)).toBe(false);
    expect(pending.requestIdFor(CODE, RETRY_WINDOW_MS)).not.toBe(id);
  });
});

describe('RepeatFilter', () => {
  it('submits a code held in view once, however long it stays', () => {
    const filter = new RepeatFilter();
    let accepted = 0;
    for (let t = 0; t <= 30_000; t += 150) if (filter.accept(CODE, t)) accepted++;
    expect(accepted).toBe(1);
  });

  it('accepts a different code at once, and the first code again after it is presented anew', () => {
    const filter = new RepeatFilter();
    expect(filter.accept('a', 0)).toBe(true);
    expect(filter.accept('a', 1_000)).toBe(false);
    expect(filter.accept('b', 1_200)).toBe(true);
    expect(filter.accept('a', 1_400)).toBe(true);
  });

  it('accepts the same code again once it has been out of view for the window', () => {
    const filter = new RepeatFilter();
    expect(filter.accept('a', 0)).toBe(true);
    expect(filter.accept('a', REPEAT_SUPPRESS_MS - 1)).toBe(false);
    expect(filter.accept('a', 2 * REPEAT_SUPPRESS_MS - 1)).toBe(true);
  });

  it('reset lets the same code be checked again immediately (after "Not verified")', () => {
    const filter = new RepeatFilter();
    filter.accept('a', 0);
    filter.reset();
    expect(filter.accept('a', 100)).toBe(true);
  });
});

describe('verdicts', () => {
  const result = (outcome: ScanOutcome, extra: Partial<ScanResult> = {}): ScanResult => ({ outcome, scanId: 1, checkedAt: '2026-11-15T14:00:00.000Z', ...extra });

  it('only an explicit admitted outcome is Admit', () => {
    const outcomes: ScanOutcome[] = ['admitted', 'already_redeemed', 'expired', 'revoked', 'invalid', 'event_closed', 'too_early', 'too_late', 'wrong_gate', 'capacity_full'];
    expect(outcomes.filter((outcome) => verdictOf(outcome) === 'admit')).toEqual(['admitted']);
  });

  it('rejects malformed responses so they become Not verified', () => {
    expect(isScanResult(result('admitted'))).toBe(true);
    expect(isScanResult(null)).toBe(false);
    expect(isScanResult({})).toBe(false);
    expect(isScanResult({ outcome: 'ok' })).toBe(false);
    expect(isScanResult({ outcome: 'toString' })).toBe(false);
    expect(isScanResult('admitted')).toBe(false);
  });

  it('failures never read as admission', () => {
    for (const error of [new ApiError(0, 't', null, 'timeout'), new ApiError(0, 'n', null, 'network'), new ApiError(500, 'x'), new Error('Unexpected response')]) {
      expect(explainFailure(error)).toMatch(/Do not admit/);
    }
    expect(explainFailure(new ApiError(0, 't', null, 'timeout'))).toContain('Retry verification');
  });

  it('explains duplicates and capacity with event-local times and safe details', () => {
    const used = result('already_redeemed', {
      pass: { id: 'p', attendeeName: 'Ada', redeemedAt: '2026-11-15T13:35:00.000Z' },
      detail: { redeemedAtGate: 'North', sameDevice: true }
    });
    expect(explain(used, 'Asia/Kolkata')).toMatch(/^First used at (15 Nov 2026 |Nov 15, 2026 )?19:05 at North on this device\.$/);
    expect(explain(result('capacity_full', { detail: { eventCapacity: true, capacity: 500 } }), 'UTC')).toBe('The event is full (500)');
    expect(explain(result('capacity_full', { detail: { policyName: 'VIP', capacity: 1 } }), 'UTC')).toBe('VIP is full (1)');
    expect(explain(result('wrong_gate', { detail: { allowedGates: ['North'] } }), 'UTC')).toBe('Use gate: North');
  });

  it('formats event-local times without the date on the event-local day', () => {
    const now = new Date('2026-11-15T15:00:00.000Z');
    expect(formatEventTime('2026-11-15T13:35:00.000Z', 'Asia/Kolkata', now)).toBe('19:05');
    expect(formatEventTime('2026-11-14T13:35:00.000Z', 'Asia/Kolkata', now)).toMatch(/14.*19:05$/);
    // An unknown zone falls back to UTC rather than throwing.
    expect(formatEventTime('2026-11-15T13:35:00.000Z', 'Not/AZone', now)).toBe('13:35');
  });
});
