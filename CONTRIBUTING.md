# Contributing

Open an issue describing the problem or proposed change, or submit a focused pull request. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

Use Node.js 22.13 or newer and `npm ci`. Setup is described in [docs/local-development.md](docs/local-development.md). Before submitting, run:

```sh
npm run typecheck
npm test
npm run build
npm run smoke:qr
```

Guidelines:

- Add tests for behaviour changes. Redemption, authentication and token handling changes need tests in `tests/redemption.test.ts`, `tests/security-api.test.ts` or `tests/database.test.ts`.
- Schema changes go in a new entry appended to the migrations array in `src/server/db.ts`. Never edit a migration that has shipped.
- Keep GET routes free of state changes, and keep raw tokens and scanner keys out of every response other than the issue/reissue/create response that produces them.
- Keep the API reference, environment variable table and database design in `README.md` in sync with the code.
- Use `example.com` and fictional names in tests and docs. Never commit real credentials, `.env`, `.local/`, databases, generated passes or build output.
- Code retained from upstream (`src/qr/*`) is MIT-licensed by CompleteTech LLC. Keep its notice; see [NOTICE](NOTICE).
