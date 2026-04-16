---
description: Verify the code implementation matches the specification documents
model: claude-opus-4-6
---

Analyze the codebase against the specification documents in `docs/` and the `README.md` to find drift between what is
promised and what is built, then guide the user through resolving each issue **one by one with explicit user input**.

## CRITICAL: Interview-Driven Resolution

**DO NOT auto-fix code or auto-edit docs.** Every discrepancy may have multiple valid resolutions:

- The code might be correct and the spec outdated
- The spec might be correct and the code needs fixing
- Both might need updates
- It might be intentionally deferred (not yet implemented)
- The discrepancy might be obsolete (already tracked in a GitHub issue)

For each issue:

1. Present the discrepancy with quotes from spec AND code
2. Explain what the spec requires vs what the code does
3. **ASK the user** what action to take using AskUserQuestion
4. Only proceed after explicit user confirmation

---

## Phase 1: Analysis

### 1.1 Read all specs

Read in full:

- `docs/spec.md` — §1 purpose through §16 empirical questions
- `docs/architecture.md` — diagram, repo layout, data model, milestones, risk register
- `docs/research.md` — empirical findings (the source of truth for "what Braiins actually does")
- `README.md` — prerequisites, "how it works," roadmap

### 1.2 Map specs to code areas

Use this mapping as a starting point. Adjust as the code base evolves:

| Spec area | Code area |
|-----------|-----------|
| `spec.md` §5 (inputs) + §6 (outputs) | `packages/braiins-client/src/**`, `packages/bitcoind-client/src/**` |
| `spec.md` §7 (run mode + mutation gate) | `packages/daemon/src/controller/gate.ts`, `packages/shared/src/decision.ts` |
| `spec.md` §8 (tunable configuration) | `packages/daemon/src/config/schema.ts`, `packages/daemon/src/state/repos/config.ts` |
| `spec.md` §9 (reliability & outage) | `packages/daemon/src/controller/decide.ts`, `packages/daemon/src/services/pool-health.ts` |
| `spec.md` §10 (ownership) | `packages/daemon/src/state/repos/owned_bids.ts`, `packages/daemon/src/controller/observe.ts` |
| `spec.md` §11 (accounting) | `packages/daemon/src/services/payout-observer.ts`, `packages/daemon/src/state/repos/*.ts` |
| `spec.md` §12 (dashboard) | `packages/dashboard/src/**`, `packages/daemon/src/http/routes/**` |
| `spec.md` §13 (API constraints) | `packages/braiins-client/src/client.ts`, `packages/braiins-client/src/errors.ts` |
| `spec.md` §14 (operational landmines) | `packages/daemon/src/controller/**`, `packages/daemon/src/services/**` |
| `architecture.md` §5 (SQLite schema) | `packages/daemon/src/state/migrations/*.sql`, `packages/daemon/src/state/types.ts` |
| `architecture.md` §2 (repo layout) | actual file tree under `packages/`, `scripts/` |

**Always also check:**

- `packages/shared/src/**` — cross-cutting types
- `scripts/**` — operator-facing utilities (setup.ts, smoke-braiins.ts, shell scripts)

### 1.3 Verify before flagging as missing

**BEFORE flagging any feature as "not implemented", you MUST verify it doesn't exist:**

1. **Search by feature keywords** — use Grep for relevant terms (case-insensitive, files_with_matches)
2. **Check all matching directories** — a feature might be in a subdirectory you didn't explicitly list, in a shared
   lib, or split across multiple locations
3. **Read actual files** — if you find matches, open them to confirm they implement the feature
4. **Only flag as missing if:** keyword search returns nothing relevant, no matching directory structure exists, and
   matches you've read don't implement the feature

### 1.4 Check for discrepancies

For each spec area, compare requirements to implementation:

**Missing implementations**

- Features described in spec but not in code
- API endpoints specified but not implemented
- Config fields defined in §8 but not in `config/schema.ts` (or vice versa)
- Migrations described in `architecture.md` §5 but missing from `migrations/`
- Run-mode / state-machine behaviour defined but not enforced

**Incorrect implementations**

- Code behaviour differs from spec
- Field names / units drift (especially `sat/PH/day` vs `sat/EH/day`)
- Validation rules differ between schema and spec
- Default values differ from spec defaults
- Workflow order differs

**Stale implementations**

- Code implements an older spec version (common after the v1.0 → v1.1 rewrite: `telegram_*`, `quiet_hours_*`,
  `confirmation_timeout_minutes`, `ActionMode` variants, `operator_available` flag)
- Removed features still referenced in code
- Renamed concepts not updated

**Missing spec coverage**

- Code features not documented in any spec
- Edge cases handled in code but not called out anywhere

**Research.md alignment**

- A spec claim based on an old assumption that research.md has since disproved and the code has (or hasn't) been
  updated for
- Code behaviour that matches research.md findings but isn't reflected in spec.md

### 1.5 Cross-reference with GitHub issues

**CRITICAL:** Before reporting findings, check if issues are already tracked on GitHub via `gh`:

1. `gh issue list --state all --limit 100` to see everything open and closed
2. For each finding, search issue titles and bodies for related keywords
3. `gh issue view <n> --comments` to read context — comments may contain decisions or reasons for deferral

Mark each finding's tracking status:

| Status | Meaning |
|--------|---------|
| 🆕 New | No existing issue covers this |
| ✅ Tracked | An open issue covers this (show issue number) |
| 📝 Enhance | An existing issue could use more detail from the spec |
| ⏸️ Deferred | Intentionally deferred (tracked but not being worked on) |
| ☑️ Closed-but-present | A closed issue claimed this was done but it isn't |

### 1.6 Report findings summary

Present a summary table:

| # | Severity | Category | Spec/Rule | Code area | Issue | GH status |
|---|----------|----------|-----------|-----------|-------|-----------|
| 1 | High | Missing config | spec §8 | `config/schema.ts` | `boot_mode` knob in spec, not in schema | 🆕 New |
| 2 | Medium | Stale | spec §7 | `config/schema.ts` | `confirmation_timeout_minutes` still in schema after v1.1 rewrite | 🆕 New |
| 3 | Medium | Unit drift | spec §8 | `http/types.ts` | StatusResponse uses `sat_per_ph_day` but spec says `sat_per_eh_day` | ✅ #12 |

**Severity**

- **High** — core functionality missing, broken, or unit-drift that could cost real money (e.g. pricing units)
- **Medium** — feature incomplete, stale code, or drift a careful reader will notice
- **Low** — cosmetic, naming, minor wording

**GH status key**

- 🆕 New — requires action (create issue or fix)
- ✅ Tracked — already has an issue; verify it's complete
- 📝 Enhance — consider adding spec detail to the existing issue
- ⏸️ Deferred — intentionally postponed; skip unless user wants to reprioritize
- ☑️ Closed-but-present — closed issue that claimed completion; reopen

**STOP HERE** and wait for the user to review the summary before proceeding.

---

## Phase 2: Resolution selection

Ask via AskUserQuestion:

- "Fix high-severity only" — address critical issues (skip ⏸️ Deferred)
- "Review new gaps only" — only work through 🆕 New findings
- "Review all issues" — work through everything one by one
- "Enrich existing issues" — add spec detail to 📝 Enhance issues
- "Create GitHub issues" — log all new gaps as issues for later
- "Review list first" — discuss before deciding

Issues marked ⏸️ Deferred are skipped by default. The user can explicitly choose to review them.

---

## Phase 3: Guided resolution (interview for each issue)

Work through issues one at a time. **Never batch or auto-fix.**

### 3.1 Present the issue (full context required)

For each issue show all of:

1. **Issue number and total** (e.g., "Issue 2 of 8")
2. **Issue title** — one sentence summary
3. **Spec says:**
   ```
   [Exact quote from spec file]
   — docs/[file].md lines X-Y
   ```
4. **Code does:**
   ```
   [Relevant code snippet or "NOT IMPLEMENTED"]
   — [file path]:[line numbers]
   ```
5. **The gap:** explain specifically what's missing or wrong
6. **Impact:** what breaks, misleads the operator, or costs money

### 3.2 Present resolution options

**If code is missing/incomplete:**

- "Fix now" — implement the missing functionality (only for simple fixes — see complexity guidelines)
- "Create GitHub issue" — log with full context
- "Skip" — not addressing now
- "Spec is wrong" — the spec needs updating, not the code

**If code contradicts spec:**

- "Update code" — change code to match spec
- "Update spec" — change spec to match code (code is correct, spec drifted)
- "Create GitHub issue" — log for later investigation
- "Skip" — intentional divergence or deferred

**If code is stale (v1.0 remnants after v1.1 rewrite):**

- "Remove from code" — delete the stale fields / logic
- "Keep for now" — there's a migration path that still needs them
- "Create cleanup issue" — log a dedicated cleanup task

### 3.3 Interview the user

Use AskUserQuestion to let the user choose their preferred action.

If user chooses "Fix now":

- Only proceed if the fix is straightforward (see complexity guidelines below)
- For anything larger, recommend a GitHub issue instead

If user chooses "Create GitHub issue":

- Gather any additional context
- Confirm the title and body before creating

### 3.4 Execute the chosen action

**For "Fix now":**

1. Show the proposed code or spec changes
2. Get explicit confirmation: "Should I make these changes?"
3. Make the changes
4. Run relevant tests if available (`pnpm -r typecheck`, `pnpm -w run test`)

**For "Create GitHub issue":**

1. Draft the issue with:
   - Clear title describing the gap
   - Description with spec quotes and code references
   - Link to relevant spec/architecture sections
   - Suggested approach
2. Show the draft to the user
3. Get confirmation before creating
4. Create via `gh issue create --body-file` (heredoc can choke on inner quotes; prefer a temp file)
5. Apply appropriate labels (see `gh label list` for this project's taxonomy)
6. Report the issue URL

**For "Enrich existing issue" (📝 Enhance status):**

1. `gh issue view <n>` and `gh issue view <n> --comments`
2. Compare spec detail to issue detail
3. Draft a comment with additional spec quotes, implementation guidance, and code-area references
4. Show draft, get confirmation
5. Add via `gh issue comment <n>`
6. Report completion

### 3.5 Move to next issue

- Confirm completion: "Issue X resolved. Moving to Issue Y."
- Repeat from 3.1

---

## Phase 4: Summary

After all issues are addressed:

1. **Changes made:** list all code/spec changes (files, what changed)
2. **Issues created:** list all GitHub issues with URLs
3. **Issues enriched:** list issues that got new comments
4. **Skipped:** list skipped items and why
5. **Recommendations:** follow-up actions — e.g., run `/check-specs` if docs were edited

---

## GitHub issue template

When creating issues via `/check-code`, use this body shape:

```markdown
## Specification
[Quote from spec with file reference and line numbers]

## Current implementation
[Description of what the code currently does, or "Not implemented"]

## Gap
[Clear explanation of what's missing or wrong]

## Files involved
- `[file path]` — [what needs to change]

## Suggested approach
[Brief implementation guidance if applicable]

---
*Generated by /check-code from [spec file]*
```

**Labels:** use project labels from `gh label list` — typically `backlog` + either `bug` or `feature`, plus any
routing labels (`agent-ready`, `human-only`) that the user wants.

---

## Guidelines

### DO

- Quote exact spec text and show actual code with line numbers
- Present all viable options for each issue
- Ask clarifying questions when user intent is unclear
- Create detailed GitHub issues with full context
- Recommend GitHub issues for complex fixes
- **Always cross-reference with `gh issue list` before flagging a gap as new**
- **Check issue comments** for decisions and context
- **Respect existing prioritization** (don't flag backlog items as urgent)
- **Enrich placeholder issues** with spec detail when appropriate

### DO NOT

- Auto-fix code without explicit approval
- Assume the spec is always correct (code might be intentionally ahead of the spec)
- Batch multiple issues together
- Create GitHub issues without user confirmation
- Attempt complex multi-file fixes directly
- Create duplicate issues for already-tracked gaps
- Ignore issue comments (they contain evolved requirements)
- Flag deferred items as urgent without user confirmation

### Complexity guidelines

- **Simple fix (do directly):** single file, < 50 lines, clear implementation
- **Medium fix (recommend GitHub issue):** multiple files, 50–200 lines, some design decisions
- **Complex fix (require GitHub issue):** architectural changes, new packages, > 200 lines

### If stuck

- If you can't find the relevant code, ask the user where to look
- If the spec is ambiguous, ask for clarification
- If unsure whether to fix or log, default to logging a GitHub issue
