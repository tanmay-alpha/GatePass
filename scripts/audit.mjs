// CI dependency audit: `npm audit` at high severity, with a short, dated list of
// advisories that were reviewed and found not to affect GatePass. An entry stops
// applying on its `until` date, so it is reviewed again rather than forgotten.
// Production dependencies get no exceptions.
import { execFileSync } from 'node:child_process';

const ACCEPTED = [
  {
    id: 'GHSA-fc5q-39xc-vjpf',
    package: 'picomatch',
    until: '2026-12-31',
    reason:
      'ReDoS through repeated extglobs in a glob pattern. picomatch is a dev-only dependency (vite, vitest, tinyglobby) matching patterns from our own build and test configuration, never user input; no patched release exists yet (4.0.7 is the latest).'
  }
];

function audit(args) {
  // Under `npm run`, npm_execpath is npm's own CLI script: run it with this Node, no shell (Windows cannot spawn npm.cmd without one).
  const [command, prefix] = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath]] : ['npm', []];
  try {
    return JSON.parse(execFileSync(command, [...prefix, 'audit', '--json', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    // npm audit exits 1 when it finds anything; its JSON is still on stdout.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

const today = new Date().toISOString().slice(0, 10);
const active = new Map(ACCEPTED.filter((entry) => entry.until >= today).map((entry) => [entry.id, entry]));
const failures = [];

const production = audit(['--omit=dev']);
for (const [name, vuln] of Object.entries(production.vulnerabilities ?? {})) {
  if (vuln.severity === 'high' || vuln.severity === 'critical') failures.push(`${name} (${vuln.severity}, production dependency)`);
}

const all = audit([]);
for (const [name, vuln] of Object.entries(all.vulnerabilities ?? {})) {
  if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue;
  // A package flagged only because it depends on another flagged package is judged by that package.
  const advisories = vuln.via.filter((via) => typeof via === 'object');
  for (const advisory of advisories) {
    const id = advisory.url?.split('/').pop();
    if (active.has(id)) console.log(`accepted until ${active.get(id).until}: ${id} in ${name} (${advisory.title})`);
    else failures.push(`${name}: ${advisory.title} (${advisory.url})`);
  }
}

if (failures.length) {
  console.error(`npm audit: ${failures.length} high or critical finding(s) not accepted:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('npm audit: no unaccepted high or critical advisories.');
