import { mkdir, writeFile } from 'node:fs/promises';
import { defaultDesignConfig } from '../src/qr/design';
import { buildPayload } from '../src/qr/payloads';
import { renderQr } from '../src/qr/renderer';

const payload = buildPayload('url', { url: 'https://example.com' });
const svg = await renderQr({ data: payload, size: 300, file: 'svg', config: { ...defaultDesignConfig, logo: '#ctech', logoMode: 'clean' } });
const png = await renderQr({ data: payload, size: 300, file: 'png', config: defaultDesignConfig });

await mkdir('.local/smoke', { recursive: true });
await writeFile('.local/smoke/qr-smoke.svg', String(svg.body));
await writeFile('.local/smoke/qr-smoke.png', png.body as Buffer);

console.log('QR smoke render complete: .local/smoke/qr-smoke.svg and .local/smoke/qr-smoke.png');
