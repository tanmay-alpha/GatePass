import { Check, CircleAlert, CircleQuestionMark, X, type LucideIcon } from 'lucide-react';
import { VERDICT_HEADLINE, type Verdict } from './outcome';

/** One scan as shown to door staff, in the overlay and in the recent list. */
export interface ScanDisplay {
  id: string;
  at: string;
  verdict: Verdict;
  /** Denial reason ("Wrong gate"); null when the headline already says it. */
  reason: string | null;
  name: string | null;
  explanation: string;
}

const VERDICT_ICON: Record<Verdict, LucideIcon> = {
  admit: Check,
  warn: CircleAlert,
  deny: X,
  error: CircleQuestionMark
};

/**
 * Covers the whole scanner. Colour, icon and headline all differ per verdict,
 * so no single cue has to carry the meaning.
 */
export function ResultOverlay({ display, onDismiss }: { display: ScanDisplay; onDismiss: () => void }) {
  const Icon = VERDICT_ICON[display.verdict];
  return (
    <button type="button" className={`result result-${display.verdict}`} onClick={onDismiss} aria-label={`${VERDICT_HEADLINE[display.verdict]}. Tap to dismiss.`}>
      <span className="result-ring" aria-hidden>
        <Icon className="result-icon" size={64} strokeWidth={2.75} />
      </span>
      <span className="result-title">{VERDICT_HEADLINE[display.verdict]}</span>
      {display.name ? <span className="result-name">{display.name}</span> : null}
      {display.reason ? <span className="result-reason">{display.reason}</span> : null}
      <span className="result-detail">{display.explanation}</span>
      <span className="result-next">Tap to scan next</span>
    </button>
  );
}
