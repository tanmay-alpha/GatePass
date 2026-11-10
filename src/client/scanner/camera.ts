/** The chosen camera is a device preference, not a credential. */
const CAMERA_KEY = 'gatepass.scannerCamera';

export interface CameraChoice {
  deviceId: string;
  label: string;
}

export function loadCameraChoice(): string | null {
  return localStorage.getItem(CAMERA_KEY);
}

export function saveCameraChoice(deviceId: string | null): void {
  if (deviceId) localStorage.setItem(CAMERA_KEY, deviceId);
  else localStorage.removeItem(CAMERA_KEY);
}

function errorName(error: unknown): string {
  return error instanceof DOMException || error instanceof Error ? error.name : '';
}

/** Errors meaning "no camera matches these constraints": try looser ones. */
function isNoMatch(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError' || name === 'ConstraintNotSatisfiedError';
}

export interface OpenedCamera {
  stream: MediaStream;
  /** False when a remembered camera was requested but is gone; forget the choice. */
  usedPreferred: boolean;
}

/**
 * Opens the remembered camera, else the rear camera, else any camera. Laptops,
 * kiosks and some tablets have no `environment` camera and reject that
 * constraint with NotFoundError or OverconstrainedError.
 */
export async function openCamera(media: Pick<MediaDevices, 'getUserMedia'>, preferredDeviceId: string | null): Promise<OpenedCamera> {
  if (preferredDeviceId) {
    try {
      return { stream: await media.getUserMedia({ video: { deviceId: { exact: preferredDeviceId } }, audio: false }), usedPreferred: true };
    } catch (error) {
      if (!isNoMatch(error)) throw error;
    }
  }
  const usedPreferred = !preferredDeviceId;
  try {
    return { stream: await media.getUserMedia({ video: { facingMode: 'environment' }, audio: false }), usedPreferred };
  } catch (error) {
    if (!isNoMatch(error)) throw error;
  }
  return { stream: await media.getUserMedia({ video: true, audio: false }), usedPreferred };
}

/** Video inputs; labels are only filled in once camera permission was granted. */
export async function listCameras(media: Pick<MediaDevices, 'enumerateDevices'>): Promise<CameraChoice[]> {
  const devices = await media.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'videoinput' && device.deviceId)
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` }));
}

/** True when the track can switch the flashlight (Chrome on Android, some others). */
export function supportsTorch(track: MediaStreamTrack): boolean {
  if (typeof track.getCapabilities !== 'function') return false;
  const capabilities: MediaTrackCapabilities & { torch?: boolean } = track.getCapabilities();
  return capabilities.torch === true;
}

export function setTorch(track: MediaStreamTrack, on: boolean): Promise<void> {
  const constraints: MediaTrackConstraints & { advanced: Array<MediaTrackConstraintSet & { torch: boolean }> } = { advanced: [{ torch: on }] };
  return track.applyConstraints(constraints);
}

export const INSECURE_CAMERA_MESSAGE =
  'The camera needs a secure connection. Open the scanner link with https:// (not http://), or use manual entry below.';

/** Staff-facing message for a failed camera start, with how to fix it. */
export function cameraErrorMessage(error: unknown): string {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera access is blocked for this site. iPhone (Safari): tap aA in the address bar → Website Settings → Camera → Allow. Android (Chrome): tap the icon left of the address → Permissions → Camera → Allow. Then tap Retry camera.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'The camera is in use by another app or tab. Close it, then tap Retry camera.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No camera found on this device. Use manual entry below.';
    case 'SecurityError':
      return INSECURE_CAMERA_MESSAGE;
    default: {
      const detail = error instanceof Error && error.message ? `: ${error.message.replace(/\.$/, '')}` : '';
      return `Camera unavailable${detail}. Tap Retry camera, or use manual entry below.`;
    }
  }
}
