import { describe, expect, it, vi } from 'vitest';
import { cameraErrorMessage, listCameras, openCamera, setTorch, supportsTorch } from '../src/client/scanner/camera';

const stream = { id: 'stream' } as unknown as MediaStream;

function media(...outcomes: Array<'ok' | string>) {
  const calls: MediaStreamConstraints[] = [];
  const getUserMedia = vi.fn(async (constraints?: MediaStreamConstraints) => {
    calls.push(constraints ?? {});
    const outcome = outcomes.shift();
    if (outcome === 'ok') return stream;
    throw new DOMException('camera failed', outcome);
  });
  return { media: { getUserMedia }, calls };
}

describe('openCamera', () => {
  it('asks for the rear camera first', async () => {
    const { media: devices, calls } = media('ok');
    expect(await openCamera(devices, null)).toEqual({ stream, usedPreferred: true });
    expect(calls).toEqual([{ video: { facingMode: 'environment' }, audio: false }]);
  });

  it.each(['NotFoundError', 'OverconstrainedError'])('falls back to any camera on %s', async (name) => {
    const { media: devices, calls } = media(name, 'ok');
    expect((await openCamera(devices, null)).stream).toBe(stream);
    expect(calls[1]).toEqual({ video: true, audio: false });
  });

  it('does not retry other constraints when permission is denied', async () => {
    const { media: devices, calls } = media('NotAllowedError');
    await expect(openCamera(devices, null)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(calls).toHaveLength(1);
  });

  it('uses the remembered camera, and reports when it is gone', async () => {
    const remembered = media('ok');
    expect(await openCamera(remembered.media, 'cam-2')).toEqual({ stream, usedPreferred: true });
    expect(remembered.calls[0]).toEqual({ video: { deviceId: { exact: 'cam-2' } }, audio: false });

    const gone = media('OverconstrainedError', 'ok');
    expect(await openCamera(gone.media, 'cam-2')).toEqual({ stream, usedPreferred: false });
    expect(gone.calls[1]).toEqual({ video: { facingMode: 'environment' }, audio: false });
  });
});

describe('camera errors', () => {
  it('explains how to recover for each failure', () => {
    const message = (name: string) => cameraErrorMessage(new DOMException('x', name));
    expect(message('NotAllowedError')).toMatch(/iPhone .*Website Settings.*Camera.*Android .*Permissions.*Camera.*Retry camera/);
    expect(message('NotReadableError')).toMatch(/in use by another app/);
    expect(message('NotFoundError')).toMatch(/No camera found/);
    expect(message('SecurityError')).toMatch(/https:\/\//);
    expect(cameraErrorMessage(new Error('Boom.'))).toBe('Camera unavailable: Boom. Tap Retry camera, or use manual entry below.');
  });
});

describe('camera devices', () => {
  it('lists video inputs with fallback labels', async () => {
    const devices = [
      { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
      { kind: 'videoinput', deviceId: 'front', label: 'Front camera' },
      { kind: 'videoinput', deviceId: 'back', label: '' }
    ] as MediaDeviceInfo[];
    expect(await listCameras({ enumerateDevices: async () => devices })).toEqual([
      { deviceId: 'front', label: 'Front camera' },
      { deviceId: 'back', label: 'Camera 2' }
    ]);
  });

  it('detects and switches the torch', async () => {
    const applyConstraints = vi.fn(async () => undefined);
    const track = { getCapabilities: () => ({ torch: true }), applyConstraints } as unknown as MediaStreamTrack;
    expect(supportsTorch(track)).toBe(true);
    await setTorch(track, true);
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });

    expect(supportsTorch({ getCapabilities: () => ({}) } as unknown as MediaStreamTrack)).toBe(false);
    expect(supportsTorch({} as MediaStreamTrack)).toBe(false);
  });
});
