import { TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'gatepass.demoNoticeDismissed';

/** True when GET /api/health reports a deployment without durable storage. */
async function isDemo(): Promise<boolean> {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) return false;
    const data: unknown = await response.json();
    return typeof data === 'object' && data !== null && 'demo' in data && data.demo === true;
  } catch {
    return false;
  }
}

/** Slim warning on demo deployments, whose data is lost on every restart. Dismissed for this browser tab only. */
export function DemoBanner() {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISSED_KEY) === '1');
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    let live = true;
    void isDemo().then((value) => live && setDemo(value));
    return () => {
      live = false;
    };
  }, [dismissed]);

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
