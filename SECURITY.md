# Security policy

Please report vulnerabilities privately through this repository's GitHub security reporting feature when available. Otherwise contact the maintainers privately before disclosing exploit details. Do not include secrets or personal information in public issues.

This project is intended for a single trusted operator. Public source availability does not make it a hardened public multi-tenant service. Follow [deployment access boundaries](docs/deployment.md) before exposing it remotely.

- Keep credentials, `.env`, keys, uploaded files, and `.local/` out of source control.
- Configure authentication for remote management. `ADMIN_TOKEN` is optional for local use.
- QR payloads may contain sensitive information such as Wi-Fi passwords. Saved records and audit history retain that content.
- Uploaded assets and landing-page URLs are public to anyone who can reach them.
- Uploads are limited to 2 MB; SVG uploads are sanitized and active content is rejected. Upload responses use a restrictive CSP.
- URL-backed content accepts HTTP(S) only. Rendering does not fetch user-provided URLs server-side.
- Rate limiting is in-memory and intended for a single process. Add limits at your reverse proxy.
- Dependencies must be kept current. Run `npm audit` when updating or deploying.

The repository's tests and dependency audit are not a comprehensive security assessment.
