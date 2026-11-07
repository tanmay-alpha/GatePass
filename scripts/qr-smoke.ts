import { mkdir, writeFile } from 'node:fs/promises';
import { defaultDesignConfig } from '../src/qr/design';
import { renderQr } from '../src/qr/renderer';

// A pass URL has the same shape and length as production passes.
const payload = `https://gatepass.example/p/${'A'.repeat(43)}`;
const svg = await renderQr({ data: payload, size: 300, file: 'svg', config: { ...defaultDesignConfig, logo: '#ctech', logoMode: 'clean' } });
const png = await renderQr({ data: payload, size: 300, file: 'png', config: defaultDesignConfig });

await mkdir('.local/smoke', { recursive: true });
await writeFile('.local/smoke/qr-smoke.svg', String(svg.body));
await writeFile('.local/smoke/qr-smoke.png', png.body as Buffer);

console.log('QR smoke render complete: .local/smoke/qr-smoke.svg and .local/smoke/qr-smoke.png');
