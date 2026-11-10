import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule } from 'barcode-detector/ponyfill';
import QRCode from 'qrcode';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFallbackDetector, createWasmDecoder, type Decoder, type FrameSource } from '../src/client/qr-detector';

const PASS_URL = 'https://gatepass.example/p/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd';

/** Minimal stand-in for the browser's ImageData (a camera frame read through a canvas). */
class FrameImageData {
  readonly colorSpace = 'srgb';
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number
  ) {}
  get [Symbol.toStringTag]() {
    return 'ImageData';
  }
}

/** Rasterises a real QR code (black modules on white, 4-module quiet zone) into RGBA pixels. */
function qrFrame(text: string, scale = 4, margin = 4): FrameSource {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const side = (modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const row = Math.floor(y / scale) - margin;
      const col = Math.floor(x / scale) - margin;
      const dark = row >= 0 && col >= 0 && row < modules.size && col < modules.size && modules.get(row, col);
      if (dark) data.fill(0, (y * side + x) * 4, (y * side + x) * 4 + 3);
    }
  }
  // Typed as a frame; at runtime it is the ImageData stand-in installed below.
  return new FrameImageData(data, side, side) as unknown as FrameSource;
}

beforeAll(async () => {
  // Node has no ImageData or DOMRectReadOnly; the decoder recognises frames with
  // `instanceof ImageData` and reports bounding boxes as DOMRectReadOnly.
  vi.stubGlobal('ImageData', FrameImageData);
  vi.stubGlobal(
    'DOMRectReadOnly',
    class {
      constructor(
        readonly x = 0,
        readonly y = 0,
        readonly width = 0,
        readonly height = 0
      ) {}
    }
  );
  const wasmPath = createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm');
  const bytes = readFileSync(wasmPath);
  await prepareZXingModule({
    overrides: { wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    fireImmediately: true
  });
});

describe('QR decoder', () => {
  it('decodes a real pass QR with the WebAssembly path', async () => {
    const [code] = await createWasmDecoder().detect(qrFrame(PASS_URL));
    expect(code?.rawValue).toBe(PASS_URL);
  });

  it('switches to WebAssembly for the session when native decoding throws on a frame', async () => {
    const native: Decoder = { detect: vi.fn(async () => Promise.reject(new DOMException('Image format not supported', 'NotSupportedError'))) };
    const detector = createFallbackDetector(native, createWasmDecoder);
    expect(detector.path).toBe('native');

    expect(await detector.detect(qrFrame(PASS_URL))).toBe(PASS_URL);
    expect(detector.path).toBe('wasm');
    expect(await detector.detect(qrFrame(PASS_URL))).toBe(PASS_URL);
    expect(native.detect).toHaveBeenCalledTimes(1);
  });

  it('stays native when a frame simply has no code', async () => {
    const native: Decoder = { detect: vi.fn(async () => []) };
    const loadWasm = vi.fn(createWasmDecoder);
    const detector = createFallbackDetector(native, loadWasm);
    expect(await detector.detect(qrFrame(PASS_URL))).toBeNull();
    expect(detector.path).toBe('native');
    expect(loadWasm).not.toHaveBeenCalled();
  });

  it('uses WebAssembly from the start without a native decoder, and returns null for blank frames', async () => {
    const detector = createFallbackDetector(null, createWasmDecoder);
    expect(detector.path).toBe('wasm');
    const blank = new FrameImageData(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64) as unknown as FrameSource;
    expect(await detector.detect(blank)).toBeNull();
  });
});
