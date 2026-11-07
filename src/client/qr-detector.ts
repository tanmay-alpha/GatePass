import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

// Serve the ZXing-C++ WebAssembly decoder from our own origin instead of the
// package's default CDN: works offline at the venue and satisfies the CSP.
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? zxingWasmUrl : prefix + path)
  }
});

/**
 * Uses the browser's native BarcodeDetector when it supports QR codes
 * (Chrome on Android, Safari 17+ on some platforms) and the ZXing WebAssembly
 * ponyfill everywhere else.
 */
export async function createQrDetector(): Promise<Pick<BarcodeDetector, 'detect'>> {
  const Native = (globalThis as { BarcodeDetector?: typeof BarcodeDetector }).BarcodeDetector;
  if (Native) {
    try {
      if ((await Native.getSupportedFormats()).includes('qr_code')) return new Native({ formats: ['qr_code'] });
    } catch {
      // Fall through to the WebAssembly implementation.
    }
  }
  return new BarcodeDetector({ formats: ['qr_code'] });
}
