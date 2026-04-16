---
description: Check specification documents for internal consistency and conflicts
model: claude-opus-4-6
---

Analyze the project's specification documents for consistency, then guide the user through resolving any issues
found **one by one with explicit user input for each**.

Scope: `docs/spec.md`, `docs/architecture.md`, `docs/research.md`, and `README.md`. This command does **not**
cross-check against code — that's what `/check-code` is for.

## CRITICAL: Interview-Driven Resolution

**DO NOT auto-resolve issues.** Every inconsistency may have multiple valid solutions, and the user must decide which
approach to take. Even if a fix seems "obvious," the user may have context or preferences that change the solution.

For each issue:

1. Present the problem with quotes from affected specs
2. Explain possible approaches (there are usually multiple)
3. **ASK the user** which approach they prefer using AskUserQuestion
4. Only after user confirms, propose the specific changes
5. Get explicit confirmation before editing any file

---

## Phase 1: Analysis

### 1.1 Read all specs

Read every file in full:

- `docs/spec.md` — product-level specification
- `docs/architecture.md` — module boundaries, data model, milestones
- `docs/research.md` — empirical findings and historical research
- `README.md` — public-facing description, prerequisites, roadmap

### 1.2 Check for inconsistencies

Look for conflicts across these documents:

**Terminology inconsistencies**

- Same concept under different names (e.g., "bid" vs "order", "autopilot" vs "controller", "autopilot-owned" vs
  "tagged")
- Run-mode / action-mode / state names that differ between documents
- Config field names that drift (e.g. spec uses `max_price_sat_per_eh_day` but architecture schema uses
  `max_price_sat_per_ph_day`)

**Business-rule conflicts**

- Contradictory rules (e.g., different thresholds for the same alert, different default timeouts)
- A rule stated in one doc that's missing from another where it would matter
- Conflicting state machines or transitions

**Data-model mismatches**

- Fields in spec §8 that aren't in architecture §5's schema
- Fields in architecture's schema that spec §8 doesn't mention
- Different types for the same field
- Required vs optional designations that drift

**API / integration mismatches**

- Endpoint paths differ between spec §13 and any architecture examples
- Pricing unit inconsistencies (`sat/PH/day` vs `sat/EH/day` — these differ by 1000×)
- Braiins API endpoint or method mismatches with research.md citations

**Cross-reference gaps**

- References to features/sections/files that don't exist
- Outdated references to removed concepts (e.g., lingering `PENDING_CONFIRMATION`, `QUIET_HOURS`, `Telegram`)
- Milestone references that no longer match the roadmap

**Research.md alignment**

- Empirical findings in research.md contradicted by claims elsewhere (e.g., a spec rule based on an old assumption
  that research has since disproved)
- Spec makes assertions that research.md doesn't cite or support

### 1.3 Report findings summary

Present a summary table:

| # | Severity | Category | Files | Issue |
|---|----------|----------|-------|-------|
| 1 | High | Terminology | spec.md, architecture.md | "autopilot-owned" vs "tagged" used inconsistently |
| 2 | Medium | Data model | spec.md §8, architecture.md §5 | `handover_window_minutes` in spec but not in schema |

**Severity:**

- **High** — contradiction likely to cause implementation bugs or operator confusion
- **Medium** — drift that a careful reader will notice; not yet a bug
- **Low** — cosmetic, wording, minor naming

**STOP HERE** and wait for the user to review the summary before proceeding.

---

## Phase 2: Resolution selection

Ask the user using AskUserQuestion:

- "Fix high-severity only" — address critical issues
- "Fix all issues" — work through everything
- "Export as GitHub issues" — create issues for later (via `gh issue create`)
- "Review list first" — user wants to discuss before deciding

---

## Phase 3: Guided resolution (interview for each issue)

Work through issues one at a time, in severity order. **Never batch or auto-resolve.**

### 3.1 Present the issue (full context required)

For the current issue, show ALL of the following so the user has complete context:

1. **Issue number and total** (e.g., "Issue 2 of 8")
2. **Issue title and summary** — one sentence describing the problem
3. **Doc A says:** exact quote with file name and line numbers
4. **Doc B says:** exact quote with file name and line numbers (or "nothing" if the issue is a gap)
5. **The conflict/gap:** explain specifically what doesn't match or what's missing
6. **Why this matters:** impact on implementation or operator understanding if left unresolved

Users may not remember earlier analysis. Always provide complete context — never assume recall.

### 3.2 Present resolution options

Most issues have multiple valid solutions. Offer them:

- Option A: Update doc X to match doc Y
- Option B: Update doc Y to match doc X
- Option C: These are actually different concepts — clarify both
- Option D: Both need updating because neither matches the current code (may require `/check-code` follow-up)

### 3.3 Interview the user

**Use AskUserQuestion** to let the user choose:

- Which approach do they prefer?
- Is there additional context (business decisions, recent code changes) that affects the choice?

Continue asking follow-up questions until the resolution is clear.

### 3.4 Propose specific changes

After the user has chosen:

- List exactly which files will be changed
- Show the specific text that will be added/modified/removed
- Explain how this resolves the inconsistency

### 3.5 Confirm before editing

Ask explicitly: **"Should I make these changes now?"**

- Only proceed with edits after user says yes
- If user wants modifications, discuss further before editing

### 3.6 Apply and move on

- Make the approved changes
- Confirm completion: "Issue X resolved. Moving to Issue Y."
- Repeat from 3.1

---

## Phase 4: Final verification

After all selected issues are resolved:

- Summarize all changes made (which files, what was changed)
- Offer to re-run analysis to catch any new issues introduced by the edits
- Remind the user to run `/check-code` if any spec claims changed, so the code can be cross-verified

---

## Guidelines

### DO

- Quote the exact conflicting text from each doc with line numbers
- Present multiple resolution options when they exist
- Ask clarifying questions until the user's intent is clear
- Keep the user informed of progress ("Issue 2 of 5")
- Wait for explicit confirmation before any edit

### DO NOT

- Auto-resolve issues, even if the fix seems obvious
- Assume one doc is more authoritative than another — ask
- Batch multiple issues together
- Edit files without explicit user approval
- Skip the interview step for "simple" issues
- Rewrite large spec sections when a surgical edit would do

### If stuck

- If an issue turns out to be a non-issue after discussion, ask whether to skip
- If the user's preferred approach isn't clear, ask more questions
- If unsure, default to asking rather than assuming
