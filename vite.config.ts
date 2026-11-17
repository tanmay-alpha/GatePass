import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Commit this build was made from: Vercel's VERCEL_GIT_COMMIT_SHA, then
 * GATEPASS_COMMIT (Docker build arg, CI), then `git rev-parse HEAD`; null when
 * none is available (for example a Docker build, which has no .git).
 */
function buildCommit(): string | null {
  for (const name of ['VERCEL_GIT_COMMIT_SHA', 'GATEPASS_COMMIT']) {
    const value = process.env[name]?.trim();
    if (value) return /^[0-9a-f]{7,64}$/i.test(value) ? value.toLowerCase() : null;
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * Writes dist/client/version.json ({ "commit": ... }) so a release check can
 * tell which commit the static frontend was built from. Client build only.
 */
function versionFile(): Plugin {
  let ssr = false;
  return {
    name: 'gatepass-version-file',
    apply: 'build',
    configResolved(config) {
      ssr = Boolean(config.build.ssr);
    },
    generateBundle() {
      if (ssr) return;
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ commit: buildCommit() })}\n` });
    }
  };
}

/** The line in public/sw.js that the build replaces with the scanner's precache list. */
const PRECACHE_MARKER = 'const PRECACHE = [];';

/**
 * Writes the scanner's precache list into its service worker (public/sw.js →
 * dist/client/sw.js). The scanner app, its CSS and the QR decoder arrive by
 * dynamic import(), so the /scan page's HTML does not name them: without the
 * list, a door phone that lost its connection before the camera ever started
 * could open the app shell offline but not the scanner or its decoder. The list
 * changes whenever those files do, which also makes browsers install the new
 * worker. Client build only.
 */
function scannerPrecache(): Plugin {
  let ssr = false;
  let publicDir = '';
  return {
    name: 'gatepass-scanner-precache',
    apply: 'build',
    configResolved(config) {
      ssr = Boolean(config.build.ssr);
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      if (ssr) return;
      const chunks = Object.values(bundle).filter((file) => file.type === 'chunk');
      const entry = chunks.find((chunk) => chunk.isEntry);
      const scanner = chunks.find((chunk) => chunk.facadeModuleId?.replaceAll('\\', '/').endsWith('/src/client/scanner/ScannerApp.tsx'));
      if (!entry || !scanner) return this.error('Scanner precache: the entry or the scanner chunk is missing from the bundle.');
      const files = new Set<string>();
      // The entry's own dynamic imports include the admin app, which the scanner never needs.
      const add = (fileName: string, followDynamic: boolean) => {
        const chunk = bundle[fileName];
        if (chunk?.type !== 'chunk' || files.has(chunk.fileName)) return;
        files.add(chunk.fileName);
        for (const file of [...(chunk.viteMetadata?.importedCss ?? []), ...(chunk.viteMetadata?.importedAssets ?? [])]) files.add(file);
        for (const next of chunk.imports) add(next, followDynamic);
        if (followDynamic) for (const next of chunk.dynamicImports) add(next, true);
      };
      add(entry.fileName, false);
      add(scanner.fileName, true);
      const source = readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
      if (!source.includes(PRECACHE_MARKER)) return this.error(`Scanner precache: public/sw.js no longer contains "${PRECACHE_MARKER}".`);
      const list = [...files].sort().map((file) => `/${file}`);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: source.replace(PRECACHE_MARKER, `const PRECACHE = ${JSON.stringify(list)};`) });
    }
  };
}

export default defineConfig({
  plugins: [react(), versionFile(), scannerPrecache()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/p/': 'http://127.0.0.1:3000'
    }
  },
  build: {
    outDir: 'dist/client'
  }
});
