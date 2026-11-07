# 0005 — Bundle the server with Vite SSR; no TypeScript transpiler in production

Status: accepted

## Context

The server is TypeScript with extensionless relative imports (`from './db'`) and shares `src/qr/` and `src/shared/` with the client. Development uses `tsx watch`. Production runs on a small VM or in a container where install size, startup time and the number of runtime packages matter, and where a dev-only tool should not be part of the attack surface.

## Decision

- `npm run build` runs `tsc --noEmit`, `vite build` (client to `dist/client`) and `npm run build:server`, which is `vite build --ssr src/server/index.ts --outDir dist/server`.
- The result is one ES module, `dist/server/index.js`. Node built-ins and the runtime `dependencies` (`express`, `express-rate-limit`, `helmet`, `qrcode`, `zod`) stay external imports; everything under `src/` is inlined.
- Production runs `node dist/server/index.js` (`npm start`, the Dockerfile `CMD`, the systemd unit). `tsx`, TypeScript and Vite are `devDependencies` and are not installed in the runtime image (`npm ci --omit=dev`).

## Consequences

- The runtime image contains `dist/`, production `node_modules`, `package.json`, `LICENSE` and `NOTICE`; no TypeScript sources.
- One bundler configuration (Vite) for client and server; no second build tool.
- The build stage of the Dockerfile runs on the builder's native platform, because `dist/` is platform-independent JavaScript; only the runtime stage is per-architecture.
- Stack traces point into the bundle rather than `src/` files.
- Tests and the benchmark still run TypeScript directly (Vitest; `tsx` for `scripts/` and the worker-thread fixture), so they exercise source, not the bundle. The Playwright suite runs the built bundle.

## Alternatives

- **`tsx` (or `ts-node`) in production.** Transpiles on every start, keeps a dev toolchain (and esbuild's native binary) in the runtime image, and adds packages to audit.
- **Node's built-in type stripping.** Does not rewrite import specifiers, so every relative import would need an explicit `.ts` extension, and it handles only erasable syntax: the constructor parameter properties in `GatePass` and `AccessControl` are not. It was also behind a flag on the Node 22 releases this project supports at the low end.
- **`tsc` emit to `dist/`.** Works, but needs `.js` extensions in every import under `NodeNext` resolution and a separate output tree for shared client/server modules. Vite already resolves both.
