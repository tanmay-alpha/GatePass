import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { templates } from '../src/qr/design';
import { renderQr } from '../src/qr/renderer';

const outDir = path.resolve('.local/screenshots/template-gallery');
const variant = process.argv[2] || 'current';

function compactSvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*>/g, '')
    .replace(/<svg([^>]*)\swidth="[^"]*"/, '<svg$1')
    .replace(/<svg([^>]*)\sheight="[^"]*"/, '<svg$1')
    .replace(/<svg /, '<svg class="qr" ');
}

const samples = await Promise.all(
  templates.map(async (template) => {
    const rendered = await renderQr({
      data: `https://example.com/qr/${template.name.toLowerCase()}`,
      size: 300,
      file: 'svg',
      config: template.config
    });

    return `<figure class="card">
      <div class="qr-wrap">${compactSvg(String(rendered.body))}</div>
      <figcaption>${template.name}</figcaption>
    </figure>`;
  })
);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Template gallery ${variant}</title>
  <style>
    :root {
      --paper: #F7FAFE;
      --ink: #07142F;
      --ink-light: #60708A;
      --rule: #C9D9EA;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: "IBM Plex Sans", Arial, sans-serif;
      padding: 28px;
    }
    h1 {
      margin: 0 0 20px;
      font: 700 28px/1.15 Georgia, serif;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 18px;
      width: 1040px;
    }
    .card {
      margin: 0;
      border: 1px solid var(--rule);
      background: #fff;
      display: grid;
      place-items: center;
      gap: 12px;
      padding: 18px 12px 14px;
    }
    .qr-wrap {
      width: 180px;
      height: 180px;
      display: grid;
      place-items: center;
      background: #fff;
    }
    .qr {
      width: 180px;
      height: 180px;
      display: block;
    }
    figcaption {
      color: var(--ink-light);
      font: 700 12px/1.25 "JetBrains Mono", Consolas, monospace;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: .1em;
    }
  </style>
</head>
<body>
  <h1>Template Gallery: ${variant}</h1>
  <main class="grid">${samples.join('\n')}</main>
</body>
</html>`;

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, `${variant}.html`), html);
console.log(path.join(outDir, `${variant}.html`));
