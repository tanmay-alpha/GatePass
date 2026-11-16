# Branch protection for `main` (recommended, NOT applied)

Status on 2026-11-17: `main` has no branch protection and no rulesets
(`gh api repos/tanmay-alpha/GatePass/branches/main/protection` → 404 "Branch not
protected"; `gh api repos/tanmay-alpha/GatePass/rulesets` → `[]`). Nothing in this
file has been applied. Applying it is the owner's decision (Settings → Rules →
Rulesets, or Settings → Branches).

## Why it matters here

The Render backend deploys `main` only after **all** GitHub checks on the commit
complete successfully (`autoDeployTrigger: checksPass`), and Vercel deploys
`main` on push. Without protection, a direct push to `main` reaches Vercel
before any check has run, and a red check after the fact only stops the
backend half, leaving the frontend and backend on different commits.

## Recommended ruleset (target: `main`)

- **Require a pull request before merging.**
  - Required approvals: 1 when a second maintainer exists; 0 while the
    repository has a single maintainer (an approval requirement the only
    maintainer cannot satisfy just gets bypassed).
  - Dismiss stale approvals when new commits are pushed.
  - Require conversation resolution before merging.
- **Require status checks to pass**, with "Require branches to be up to date
  before merging" on (the checks must have run against the merge result that
  Render will deploy). Exact check names, as reported on PR #14:

  | Workflow | Required check names |
  | --- | --- |
  | `ci.yml` (CI) | `check (ubuntu-latest, 22)`, `check (ubuntu-latest, 24)`, `check (windows-latest, 24)`, `e2e (chromium)`, `e2e (firefox)`, `e2e (webkit)`, `e2e (mobile-chrome)`, `docker`, `docker-run` |
  | `security.yml` (Security) | `secret scan (gitleaks)` |
  | `codeql.yml` (CodeQL) | `analyze (javascript-typescript)`, `analyze (actions)` |
  | GitHub code scanning | `CodeQL` (the results check created from the uploads; blocks on new alerts at the configured severity) |

  Select them with the GitHub Actions app as the source so another app cannot
  satisfy them with a same-named status.
- **Block force pushes** and **restrict deletions** of `main`.
- **Require linear history** (optional): the repository merges with merge
  commits today (`Merge pull request #14 …`); only turn this on together with a
  switch to squash or rebase merging.
- **Bypass list:** empty. If the owner needs an emergency path, add the
  repository admin role with "pull requests only", so even a bypass leaves a PR.

## Checks that must NOT be required

- `release-check` (`release-verify.yml`): runs only on `workflow_dispatch` and
  `schedule`, never on pull requests, so a requirement could never be met. It is
  a post-deploy gate. Runs on `main` are still checks on main's head commit, which
  Render waits for; `scripts/release-check.ts` defers (exit 0, "deferred, not a
  pass") instead of waiting or failing while that commit's deploy is pending
  (see [deployment-runbook.md](deployment-runbook.md), gate 6).
- `dependency-review` (`security.yml`): skipped unless the repository variable
  `DEPENDENCY_REVIEW=true`, which needs the Dependency graph. A job skipped by
  its `if:` reports success, so requiring it now proves nothing. Require it once
  the Dependency graph is on and the variable is set.
- `Vercel`, `Vercel Preview Comments`: produced by the Vercel GitHub app for
  previews. They are useful signals, but making them required ties merges to
  Vercel availability; leave them optional.

## Matrix and job renames

Required check names are literal strings. Renaming a job, changing a matrix
entry (for example dropping Node 22 or adding a browser) or renaming a
workflow's `name:` creates a new check name and leaves the old one "expected"
forever, which blocks every PR. Update the ruleset in the same PR that changes
the names.

## Dependabot

Dependabot PRs run the same checks (with a read-only token), so the ruleset
applies to them unchanged. Action pins are full commit SHAs with a `# vX.Y.Z`
comment; Dependabot's `github-actions` ecosystem updates both.

## Applying (owner only)

Review the JSON before running it; it replaces any existing ruleset of the same name.

```sh
gh api -X POST repos/tanmay-alpha/GatePass/rulesets --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "check (ubuntu-latest, 22)", "integration_id": 15368 },
          { "context": "check (ubuntu-latest, 24)", "integration_id": 15368 },
          { "context": "check (windows-latest, 24)", "integration_id": 15368 },
          { "context": "e2e (chromium)", "integration_id": 15368 },
          { "context": "e2e (firefox)", "integration_id": 15368 },
          { "context": "e2e (webkit)", "integration_id": 15368 },
          { "context": "e2e (mobile-chrome)", "integration_id": 15368 },
          { "context": "docker", "integration_id": 15368 },
          { "context": "docker-run", "integration_id": 15368 },
          { "context": "secret scan (gitleaks)", "integration_id": 15368 },
          { "context": "analyze (javascript-typescript)", "integration_id": 15368 },
          { "context": "analyze (actions)", "integration_id": 15368 }
        ] } },
    { "type": "code_scanning", "parameters": { "code_scanning_tools": [
        { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" } ] } }
  ]
}
JSON
```

`15368` is the GitHub Actions app id. The `code_scanning` rule blocks a merge
that introduces new CodeQL alerts at or above the thresholds; it replaces
requiring the `CodeQL` results check by name.
