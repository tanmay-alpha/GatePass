# Architecture

- `src/client`: React UI and theme controls.
- `src/qr`: payload validation, design presets, SVG rendering, and PNG generation.
- `src/server`: Express routes, landing pages, uploads, and JSON storage.
- `src/yourls`: server-side YOURLS API client.
- `src/shared`: shared types.

Static QR records encode their content directly. Dynamic URL records encode a short link whose destination routes through `/r/:id`, so editing the stored destination preserves the QR image. Dynamic payload records point to `/l/:id` landing pages. Without YOURLS credentials, `/r/:keyword` supplies local short links.

Runtime data lives in ignored `.local/` by default. The JSON store is intended for one process and modest local workloads. It is not a transactional database.

The optional YOURLS plugin in `yourls/user/plugins/ctech-qr` adds a QR action and `ctech_qr_ping` API action. Set `CTECH_QR_STUDIO_URL` in your YOURLS configuration to your toolkit origin. The plugin is a scaffold; validate it against your own YOURLS deployment before enabling it.
