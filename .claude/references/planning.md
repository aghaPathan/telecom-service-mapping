# Planning artifacts (reference)

GitHub is the source of truth for issue status — this file is a pointer, not a ledger. Read it to understand how the project is structured, not to check what's done.

## Documents

- **Parent PRD:** GitHub issue [#1](https://github.com/aghaPathan/telecom-service-mapping/issues/1).
- **Slice issues:** #2–#12 — tracer-bullet first, then feature widening. Run `gh issue list --state open --limit 50 --json number,title,labels,assignees` for live status.
- **ADRs:** `docs/decisions/` — create one when a canonical decision flips. Numbered (`0001-…`, `0002-…`).
- **Implementation plans:** `docs/plans/` — per-issue markdown plans from `superpowers:writing-plans`, dated.

## Slicing conventions

- One slice issue = one PR on a `feat/issue-N-slug` branch (per-issue `issues-to-complete` flow).
- `Closes #N` in the PR body auto-closes the issue on merge.
- Branch-name convention enforced by a pre-commit hook: `{type}/{description}` where type ∈ feat/fix/refactor/chore/docs/test/ci/perf/style/build/revert/hotfix.

## Labels

- `in-progress` — someone is actively working an issue. Added on claim, removed on merge.
- No others are load-bearing today.

## Live status

Use `gh` — don't read stale snapshots from this file.

```bash
gh issue list --state open --limit 50 --json number,title,labels,assignees
gh pr list --state open
```
