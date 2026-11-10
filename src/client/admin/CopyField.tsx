import { Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

/**
 * Read-only link with a copy button, for secrets shown once (invitations,
 * reset links, scanner setup). If the clipboard is unavailable the text is
 * selected so it can be copied by hand.
 */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();

  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      input.current?.select();
      setState('manual');
    }
  }

  return (
    <div className="stack-sm">
      <div className="inline-form">
        <label className="grow">
          {label}
          <input ref={input} readOnly value={value} onFocus={(e) => e.target.select()} aria-describedby={hint ? hintId : undefined} />
        </label>
        <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
          <Copy size={14} aria-hidden /> {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      <span className="sr-only" role="status">
        {state === 'copied' ? `${label} copied` : state === 'manual' ? 'Copying is blocked here. The link is selected; copy it with your keyboard.' : ''}
      </span>
      {state === 'manual' ? <p className="field-hint">Copying is blocked in this browser. The link is selected; press Ctrl+C (⌘C on a Mac).</p> : null}
    </div>
  );
}
