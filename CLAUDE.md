# Project conventions for Claude sessions

## Issue lifecycle

**Never close GitHub issues.** Operator closes them manually after
verifying the fix on the running dashboard.

When a commit resolves an issue:

- **Do not** put `Closes #N` / `Fixes #N` / `Resolves #N` in the commit
  message — those auto-close on push to main.
- **Do** apply the `review` label to the issue and remove any status
  label that no longer applies (`backlog`, `in-progress`, etc.).
- **Do** mention the issue number in the commit body (e.g. "addresses
  #N", "per #N") so the commit is linked to the issue without closing
  it.

Issues sit in `review` until the operator confirms the fix is live and
behaving as intended, then the operator closes.

When you start implementing work for an issue, move it to
`in-progress` immediately (remove `backlog` / `todo` / `queued` /
`agent-ready` as applicable) without asking first. When the work
ships, swap `in-progress` for `review` as described above.

`agent-ready` means "ready to be picked up by an agent" — it's an
*inbox* signal set by the operator after they finish triaging an
issue. Once an agent starts on it (and certainly once the work
ships) the label is stale and must be removed. Never leave
`agent-ready` on an issue that is `in-progress` or `review`.

## Picking labels

Pick labels freely from the current `gh label list` when filing or
triaging issues — no need to show the chosen set for approval
beforehand. Include workflow-stage (`backlog`/`todo`/`in-progress`/
`review`/etc.), type (`bug`/`feature`/`infra`/`discuss`), and
triage/routing labels (`agent-ready`/`human-only`/`hold`/
`waiting-for`) as they apply. Use judgment.

**Never apply `user-request`.** That label is reserved for issues
raised by external users; the operator applies it manually on the
rare occasion it fits. Everything the operator (or you on the
operator's behalf) files is not a `user-request`.

## Label taxonomy

Imported from the VoicePaste workflow. Workflow stages:
`backlog → todo → queued → in-progress → developer-testing → review →
staging`. Plus `agent-ready`, `agent-testing`, `human-only`, `hold`,
`cancelled`, `waiting-for`. Types: `bug`, `feature`, `infra`,
`discuss`. Run `gh label list` for the current full set.

## Commit hygiene

Match existing style — subject line in the imperative, short summary,
body explains the "why" not just the "what," Co-Authored-By trailer on
Claude-assisted commits.

## Build number

`BUILD_NUMBER` in the repo root is an integer shown in the dashboard
footer (`build 42 · abc1234`). Increment it in every commit that
changes dashboard or daemon code. Read the current value, add 1, write
it back. Skip for doc-only or config-only changes.

## Parallel sessions

Another Claude session is often editing `packages/**` in parallel.
Before committing anything touching `packages/daemon/src/config/schema.ts`,
`packages/daemon/src/state/migrations/`, or the dashboard pages, check
`git status` and avoid capturing half-written code from the other
session. Doc-only and commands-only commits are always safe.

## Writing GitHub issue/PR bodies

Prefer `gh issue create --body-file <path>` (or `--body-file -` via
stdin) over the `-b "$(cat <<'EOF' ... EOF)"` trick. Bodies contain
backticks in fenced code blocks, which break shell command
substitution even with a single-quoted heredoc delimiter. Write the
body to a temp file first, then pass `--body-file`.

## Running the daemon

A fix landing in `main` is not a fix landing in the running daemon —
the operator must restart it for new code to take effect. When an
operator reports a bug still present after a fix was committed,
sanity-check: did the daemon restart since the commit? Restart scripts
live in `scripts/restart.sh` / `scripts/start.sh` / `scripts/stop.sh`.
