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

export const VERDICT_ICON: Record<Verdict, LucideIcon> = {
  admit: Check,
  warn: CircleAlert,
  deny: X,
  error: CircleQuestionMark
};

/** Colour, icon and headline all differ per verdict, so no single cue has to carry the meaning. */
export function ResultOverlay({ display, onDismiss }: { display: ScanDisplay; onDismiss: () => void }) {
  const Icon = VERDICT_ICON[display.verdict];
  return (
    <button type="button" className={`result result-${display.verdict}`} onClick={onDismiss} aria-label={`${VERDICT_HEADLINE[display.verdict]}. Tap to dismiss.`}>
      <Icon className="result-icon" size={96} strokeWidth={3} aria-hidden />
      <span className="result-title">{VERDICT_HEADLINE[display.verdict]}</span>
      {display.reason ? <span className="result-reason">{display.reason}</span> : null}
      {display.name ? <span className="result-name">{display.name}</span> : null}
      <span className="result-detail">{display.explanation}</span>
    </button>
  );
}
