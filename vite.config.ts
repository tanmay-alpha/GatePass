import { execFileSync } from 'node:child_process';
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

export default defineConfig({
  plugins: [react(), versionFile()],
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
