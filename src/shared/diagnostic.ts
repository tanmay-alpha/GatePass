/**
 * Camera test codes for the scanner readiness check. A diagnostic QR proves
 * that the door device's camera and decoder can read a code; it is decoded on
 * the device only and never sent to the server. The server still treats any
 * payload with this prefix as `invalid` (never a pass), so a test code can
 * never admit even if a client sent it.
 */
export const DIAGNOSTIC_PREFIX = 'gatepass:diagnostic:';
const DIAGNOSTIC_V1 = /^gatepass:diagnostic:v1:[A-Za-z0-9_-]{8,64}$/;

/** True for anything that claims to be a diagnostic code (any version, any nonce): never a pass. */
export function isDiagnosticPayload(value: string): boolean {
  return value.trim().toLowerCase().startsWith(DIAGNOSTIC_PREFIX);
}

/** True for a well-formed version-1 test code, the only kind the readiness check accepts as a pass of the camera test. */
export function isValidDiagnosticCode(value: string): boolean {
  return DIAGNOSTIC_V1.test(value.trim());
}

/** A fresh version-1 test code; the nonce only makes each printed code distinct. */
export function diagnosticPayload(nonce: string): string {
  return `${DIAGNOSTIC_PREFIX}v1:${nonce}`;
}
