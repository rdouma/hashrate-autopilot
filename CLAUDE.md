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

## Changelog

`CHANGELOG.md` at repo root. Format: `## YYYY-MM-DD` headers (newest
first), entries as `### \`[Tag]\` Brief title (#issue)` + a 1–3
sentence body explaining user-visible impact. Tags in use: `[Feature]`,
`[Fix]`, `[UI]`, `[Perf]`, `[Infra]`, `[Docs]`. Date is the
implementation date (`date +%Y-%m-%d`), not the issue-open date.

Every behavior-change commit gets an entry in the same commit that
changes the behavior — not a later catch-up sweep. Skip pure
refactors with no user-visible effect and pure doc-only commits
(those are already visible in git log).

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

## Umbrel image pin convention (load-bearing — do not get this wrong)

`rdouma-hashrate-autopilot/docker-compose.yml` pins
`image: ghcr.io/rdouma/hashrate-autopilot:<tag>`. Umbrel reads this
file straight from `main` to install/update the app. If the tag does
not exist on GHCR, every Umbrel install hangs on "Updating" forever
(empirical incident: v1.4.1, see CHANGELOG 2026-04-27).

**Rules:**

1. **Never pin `:latest`** in a release manifest. `:latest` can
   silently regress; pin a specific version.
2. **Pin bare semver, not v-prefixed.** Use `:1.4.2`, not `:v1.4.2`.
   The publish workflow's `docker/metadata-action` strips the `v`
   from semver tags by convention — GHCR carries `1.4.2` / `1.4` /
   `1` / `latest`. We *also* publish `v`-prefixed mirrors as a safety
   net, but the canonical pin is bare-semver to match what GHCR's UI
   shows.
3. **Bump three things in lockstep on every release:** the git tag
   (`vX.Y.Z`), the `umbrel-app.yml` `version:` field (`X.Y.Z`), and
   the `docker-compose.yml` `image:` tag (`:X.Y.Z`). All three must
   refer to the same release. The CI workflow
   `.github/workflows/umbrel-image-pin-check.yml` enforces the
   manifest-version-vs-compose-image consistency on every push to
   `main` — if it fails, the release is broken before users see it.
4. **Verify the image exists on GHCR before announcing the
   release.** After tagging, wait for the publish run to finish
   (~7-8 min, multi-arch build) and `curl` the manifest:
   ```
   TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:rdouma/hashrate-autopilot:pull" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
   curl -sI -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/rdouma/hashrate-autopilot/manifests/<tag>" | head -1
   ```
   `HTTP/2 200` = good. `404` = the publish failed or the tag pattern
   produced something else; investigate before promoting the manifest.

**Standard release sequence** (use this every time, the CI gate
expects it):

1. Bump `BUILD_NUMBER`, `umbrel-app.yml` `version:`,
   `docker-compose.yml` `image:` tag, and add a CHANGELOG entry,
   all in one commit.
2. `git tag -a vX.Y.Z -m "<title>"` on that commit.
3. `git push --atomic origin main vX.Y.Z` - main and the tag
   together so the publish workflow (tag-triggered) runs in
   parallel with the gate check (main-triggered). The gate polls
   GHCR for ~10 min, comfortably outliving the ~8 min publish.

If you push main first and forget the tag, the gate will retry for
10 min and then fail loudly - that's the safety net. Push the tag.

If a user reports the app stuck on "Updating": their docker-compose
pin is pulling a 404'ing image. UI-only recovery for them is
**Settings → Restart Umbrel** (drops the in-flight install job and
re-syncs the community store on boot). Uninstall + reinstall also
works but wipes `app-data/`.
