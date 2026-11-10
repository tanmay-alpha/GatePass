import { Check, CircleAlert, CircleQuestionMark, RotateCcw, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { REPLAYED_NOTE, VERDICT_HEADLINE, type Verdict } from './outcome';

/** One scan as shown to door staff, in the overlay and in the recent list. */
export interface ScanDisplay {
  id: string;
  at: string;
  verdict: Verdict;
  /** Denial reason ("Wrong gate"); null when the headline already says it. */
  reason: string | null;
  name: string | null;
  explanation: string;
  /** The server's stored answer to an earlier request whose response was lost. */
  replayed: boolean;
  /** Set when no answer arrived: the code to re-send with the same requestId. */
  retryCode: string | null;
}

const VERDICT_ICON: Record<Verdict, LucideIcon> = {
  admit: Check,
  warn: CircleAlert,
  deny: X,
  error: CircleQuestionMark
};

interface Props {
  display: ScanDisplay;
  onDismiss: () => void;
  /** Present for unanswered scans: re-sends the same code with the same requestId. */
  retry?: { onRetry: () => void; disabled: boolean; checking: boolean };
}

/**
 * Covers the whole scanner. Colour, icon and headline all differ per verdict,
 * so no single cue has to carry the meaning. An alert dialog: the headline is
 * its name and the details its description, so screen readers announce both;
 * focus moves in, Tab stays inside, Escape or a tap anywhere dismisses.
 */
export function ResultOverlay({ display, onDismiss, retry }: Props) {
  const Icon = VERDICT_ICON[display.verdict];
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [display.id]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled)'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={ref}
      className={`result result-${display.verdict}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="result-title"
      aria-describedby="result-desc"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={onDismiss}
    >
      <span className="result-ring" aria-hidden>
        <Icon className="result-icon" size={64} strokeWidth={2.75} />
      </span>
      <h2 id="result-title" className="result-title">
        {VERDICT_HEADLINE[display.verdict]}
      </h2>
      <div id="result-desc" className="result-desc">
        {display.name ? <p className="result-name">{display.name}</p> : null}
        {display.reason ? <p className="result-reason">{display.reason}</p> : null}
        <p className="result-detail">{display.explanation}</p>
        {display.replayed ? <p className="result-note">{REPLAYED_NOTE}</p> : null}
      </div>
      {/* Taps on the actions (even on a disabled Retry) must not count as "tap anywhere to dismiss". */}
      <div className="result-actions" onClick={(event) => event.stopPropagation()}>
        {retry ? (
          <button type="button" className="result-btn result-retry" disabled={retry.disabled} onClick={retry.onRetry}>
            <RotateCcw size={20} aria-hidden />
            {retry.checking ? 'Checking…' : 'Retry verification'}
          </button>
        ) : null}
        <button type="button" className="result-btn result-next" onClick={onDismiss}>
          Scan next
        </button>
      </div>
    </div>
  );
}
