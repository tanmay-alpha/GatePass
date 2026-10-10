# Contributing

Open an issue describing the problem or proposed improvement, or submit a focused pull request. For security problems, follow [SECURITY.md](SECURITY.md).

Use Node.js 22.12 or newer and `npm ci`. Before submitting, run:

```sh
npm run typecheck
npm test
npm run build
npm run smoke:qr
```

Add tests for behavior changes. Use example.com and fictional sample data. Never commit real credentials, private infrastructure details, generated data, or dependency/build directories. Keep documentation accurate about supported export formats and deployment limitations.
