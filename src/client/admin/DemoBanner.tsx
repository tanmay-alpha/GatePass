import { TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';

const DISMISSED_KEY = 'gatepass.demoNoticeDismissed';

/**
 * Slim warning on demo deployments (`GET /api/health` reports `demo: true`),
 * whose data is lost on every restart. Dismissed for this browser tab only.
 */
export function DemoBanner({ demo }: { demo: boolean }) {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISSED_KEY) === '1');

  if (!demo || dismissed) return null;
  return (
    <div className="demo-banner" role="status">
      <TriangleAlert size={16} className="demo-banner-icon" aria-hidden />
      <p>
        <strong>Demo environment</strong> — data is erased whenever the server restarts. Do not use for a real event.
      </p>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss demo notice"
        onClick={() => {
          sessionStorage.setItem(DISMISSED_KEY, '1');
          setDismissed(true);
        }}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
