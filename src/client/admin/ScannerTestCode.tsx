import { QrCode } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { diagnosticPayload } from '../../shared/diagnostic';
import { errorMessage } from '../ui';
import { adminQrUrl } from './http';
import './ScannerTestCode.css';

/** A random nonce, so each printed or shown test code is distinct; it carries no secret. */
function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Camera test code for the door devices' readiness check. A scanner reads it on
 * the device and never sends it to the server (and the server would refuse it
 * as invalid anyway), so it can be printed or shown on any screen.
 */
export function ScannerTestCode() {
  const [open, setOpen] = useState(false);
  const [payload] = useState(() => diagnosticPayload(nonce()));
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');

  // The image keeps showing its URL until a new one replaces it, so a URL is revoked only once replaced or unmounted.
  const shown = useRef('');
  useEffect(() => () => URL.revokeObjectURL(shown.current), []);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError('');
    adminQrUrl(payload, {})
      .then((value) => {
        if (!live) return URL.revokeObjectURL(value);
        URL.revokeObjectURL(shown.current);
        shown.current = value;
        setSrc(value);
      })
      .catch((err) => {
        if (!live) return;
        URL.revokeObjectURL(shown.current);
        shown.current = '';
        setSrc('');
        setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [open, payload]);

  return (
    <details className="scanner-test-code" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <QrCode size={15} aria-hidden /> Camera test code
      </summary>
      <p className="muted small">
        Door staff run a camera test before scanning: on the door device tap <strong>Test camera</strong> and point it at this code, shown on a second screen or printed. It is not a pass: the
        device reads it locally and never admits anyone with it.
      </p>
      <div className="setup-qr">{src ? <img src={src} alt="Camera test QR code" /> : <div className="qr-placeholder">{error ? <span className="small">{error}</span> : null}</div>}</div>
    </details>
  );
}
