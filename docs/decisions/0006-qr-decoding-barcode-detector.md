# 0006 — QR decoding in the browser with `barcode-detector`

Status: accepted

## Context

Door staff scan with whatever phone they have: Chrome on Android, Safari on iOS, sometimes a laptop. Decoding has to be fast on mid-range phones, work under a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`), and not depend on a third-party CDN at the venue. The pass design editor also decodes previews with the same decoder to refuse designs the scanner cannot read.

## Decision

Use [`barcode-detector`](https://github.com/Sec-ant/barcode-detector) (MIT), wrapped in `src/client/qr-detector.ts`:

- If the browser has a native `BarcodeDetector` and `getSupportedFormats()` includes `qr_code`, use it.
- Otherwise use the package's ponyfill, which implements the same W3C Barcode Detection API on [`zxing-wasm`](https://github.com/Sec-ant/zxing-wasm) (ZXing-C++ compiled to WebAssembly).
- The `.wasm` file is bundled by Vite and served from the GatePass origin (`prepareZXingModule` with a `locateFile` override) instead of the package's default CDN.

Both packages are build-time `devDependencies`; they end up in the client bundle only.

## Consequences

- One API (`detect(video)`) for native and fallback paths; the scanner loop does not branch.
- The CSP needs `'wasm-unsafe-eval'` to compile the decoder. No other script source is allowed.
- Scanning keeps working if the venue network cannot reach public CDNs, as long as it reaches the GatePass server (which scanning needs anyway).
- Verified in headless Chromium through the design editor's decode check (ZXing path). Real phone cameras have not been tested ([testing.md](../testing.md#verification-status)).
- Browsers without a native detector download the decoder on first use: `zxing_reader.wasm` is 946,860 bytes uncompressed in the current build (`dist/client/assets/`).

## Alternatives

- **`jsQR`.** Pure JavaScript, small and simple, but unmaintained: the latest npm release (1.4.0) is from April 2021. It decodes from raw pixel buffers only, so the camera-to-canvas plumbing is ours, and it is slower than native or WebAssembly decoding on large frames.
- **`html5-qrcode`.** Bundles its own camera UI and a vendored JavaScript ZXing port; latest npm release 2.3.8, April 2023. Its UI and DOM handling would fight the scanner's own result overlay and accessibility work, and we would still carry an older decoder.
- **Native `BarcodeDetector` only.** Not available in every browser door staff use; would need a fallback anyway.
- **Server-side decoding of uploaded frames.** Sends camera images over the network, adds latency per frame and CPU load on the single server process.
