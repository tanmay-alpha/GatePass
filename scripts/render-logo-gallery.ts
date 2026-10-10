import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logoGallery } from '../src/qr/design';
import { getLogoIcon } from '../src/qr/logo-icons';

const outDir = path.resolve('.local/screenshots/logo-gallery');
const variant = process.argv[2] || 'current';

function iconSvg(name: string): string {
  const icon = getLogoIcon(name);
  if (!icon) {
    return `<svg viewBox="0 0 100 100" role="img" aria-label="${name}"><circle cx="50" cy="50" r="46" fill="#07142F"/><text x="50" y="57" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#F7FAFE">${name.slice(0, 2).toUpperCase()}</text></svg>`;
  }

  return `<svg viewBox="0 0 100 100" role="img" aria-label="${name}"><circle cx="50" cy="50" r="49" fill="${icon.bg}"/><g fill="${icon.fg}">${icon.body}</g></svg>`;
}

function html(): string {
  const cards = logoGallery.map((name) => {
    return `<figure class="card">
      <div class="icon">${iconSvg(name)}</div>
      <figcaption>${name}</figcaption>
    </figure>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Logo gallery ${variant}</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #F7FAFE;
      --paper-deep: #E8F1FB;
      --ink: #07142F;
      --ink-light: #60708A;
      --rule: #C9D9EA;
      --gold: #FDB913;
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
      grid-template-columns: repeat(5, 1fr);
      gap: 16px;
      width: 980px;
    }
    .card {
      margin: 0;
      border: 1px solid var(--rule);
      background: #fff;
      min-height: 164px;
      display: grid;
      place-items: center;
      gap: 10px;
      padding: 16px 10px 12px;
    }
    .icon {
      width: 96px;
      height: 96px;
      display: grid;
      place-items: center;
      background:
        linear-gradient(45deg, #edf4fb 25%, transparent 25%),
        linear-gradient(-45deg, #edf4fb 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #edf4fb 75%),
        linear-gradient(-45deg, transparent 75%, #edf4fb 75%);
      background-position: 0 0, 0 8px, 8px -8px, -8px 0;
      background-size: 16px 16px;
    }
    svg {
      width: 84px;
      height: 84px;
      display: block;
      overflow: visible;
    }
    figcaption {
      color: var(--ink-light);
      font: 600 11px/1.25 "JetBrains Mono", Consolas, monospace;
      text-align: center;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <h1>Logo Gallery: ${variant}</h1>
  <main class="grid">${cards}</main>
</body>
</html>`;
}

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, `${variant}.html`), html());
console.log(path.join(outDir, `${variant}.html`));
