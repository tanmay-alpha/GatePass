import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/** Which decoder is reading frames: the browser's BarcodeDetector or the ZXing WebAssembly build. */
export type DecoderPath = 'native' | 'wasm';

/** Anything a BarcodeDetector accepts: a video element, canvas, ImageData, Blob… */
export type FrameSource = Parameters<BarcodeDetector['detect']>[0];

export interface Decoder {
  detect(source: FrameSource): Promise<Array<{ rawValue: string }>>;
}

export interface QrDetector {
  /** Changes from 'native' to 'wasm' (once, permanently) if native decoding fails. */
  readonly path: DecoderPath;
  /** The first QR payload in the frame, or null when there is none. */
  detect(source: FrameSource): Promise<string | null>;
}

/**
 * Wraps a native decoder with a WebAssembly fallback. Some browsers advertise
 * QR support but throw on every video frame (iOS Safari: "Image format not
 * supported"); the first such error switches this detector to WebAssembly for
 * the rest of the session and decodes the same frame again. "No code in this
 * frame" is an empty result, not an error, so it never triggers the switch.
 */
export function createFallbackDetector(native: Decoder | null, loadWasm: () => Decoder): QrDetector {
  let wasm: Decoder | null = null;
  let path: DecoderPath = native ? 'native' : 'wasm';
  const viaWasm = async (source: FrameSource) => {
    wasm ??= loadWasm();
    const [code] = await wasm.detect(source);
    return code?.rawValue ?? null;
  };
  return {
    get path() {
      return path;
    },
    async detect(source) {
      if (path === 'native' && native) {
        try {
          const [code] = await native.detect(source);
          return code?.rawValue ?? null;
        } catch {
          path = 'wasm';
        }
      }
      return viaWasm(source);
    }
  };
}

/** The ZXing WebAssembly decoder (barcode-detector ponyfill). Configure the module before the first call. */
export function createWasmDecoder(): Decoder {
  return new BarcodeDetector({ formats: ['qr_code'] });
}

let wasmConfigured = false;

/**
 * Serve the ZXing-C++ WebAssembly decoder from our own origin instead of the
 * package's default CDN: works offline at the venue and satisfies the CSP.
 */
function useBundledWasm(): void {
  if (wasmConfigured) return;
  wasmConfigured = true;
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? zxingWasmUrl : prefix + path)
    }
  });
}

/**
 * Uses the browser's native BarcodeDetector when it supports QR codes
 * (Chrome on Android, Safari 17+ on some platforms) and the ZXing WebAssembly
 * ponyfill everywhere else, or once native decoding fails at runtime.
 */
export async function createQrDetector(): Promise<QrDetector> {
  useBundledWasm();
  // Not in TypeScript's DOM lib; where present it has the ponyfill's shape.
  const Native: typeof BarcodeDetector | undefined = Reflect.get(globalThis, 'BarcodeDetector');
  let native: Decoder | null = null;
  if (Native) {
    try {
      if ((await Native.getSupportedFormats()).includes('qr_code')) native = new Native({ formats: ['qr_code'] });
    } catch {
      // Use the WebAssembly implementation.
    }
  }
  return createFallbackDetector(native, createWasmDecoder);
}
