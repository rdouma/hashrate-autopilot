# Contributing

Hello, fellow plebs miner, and thanks for taking the time to look. Hashrate Autopilot is a one-person hobby project; I 
welcome contributions but I'm not on this 24/7. A few ground rules so we both know what to expect.

## How I work

- Solo project, best-effort response. No SLA, no on-call.
- I ship from `main` directly. There is no long-running release branch and no "develop" stage. Tagged versions
  (`vX.Y.Z`) are the contract; `main` between tags is fast-moving but is expected to typecheck and
  pass tests.
- I read every issue and PR. I'll get back to you, but the timing depends on what's going on in my life.

## Before you open a PR

For tiny things (typo, a clearly-wrong unit, a missing translation), just open a PR. For larger changes it would be 
nice to have a [discussion](https://github.com/rdouma/hashrate-autopilot/discussions)) first. 

## What I'm likely to merge

- Bug fixes with a clear repro and a focused diff.
- Translations into a locale that doesn't exist yet (Czech, German, French, etc.) following the term policy in
  [`packages/dashboard/src/lib/i18n.ts`](packages/dashboard/src/lib/i18n.ts). See the existing `nl` and `es` `.po` files in
  `packages/dashboard/src/locales/` for the pattern.
- Improvements to the Umbrel / Docker / bare-metal install paths, documentation, and dev experience.
- Tests for existing untested behaviour.

## What I'm likely to push back on

- Anything touching payout addresses, fee fields, withdrawal logic, or the bid-mutation path needs extra review and 
  a strong rationale.
- Sweeping refactors without a concrete user-facing improvement attached. The codebase isn't perfect, but "I rewrote 
  this to be cleaner" PRs need to do something visible too.
- Features that drift from the project's stated scope: non-custodial mining via Datum-compatible pools, with a 
  hashrate marketplace as the buying side. Hashrate Autopilot has always been intended to be marketplace-agnostic - 
  Braiins Hashpower is the only such market I know of today, so it's the only one currently integrated, but I'd
  welcome adding others if/when they appear. (Some Braiins-specific language is still embedded in older variable 
  names and the database schema; that's historical accident, not statement of scope.)

## Dev setup

```bash
# Prerequisites: Node 22+, pnpm 10+
git clone https://github.com/rdouma/hashrate-autopilot.git
cd hashrate-autopilot
pnpm install

# Daemon (live-reload via tsx)
pnpm daemon

# Dashboard (Vite dev server, proxies API to localhost:3000)
pnpm --filter @braiins-hashrate/dashboard dev
```

Useful commands:

- `pnpm test` - run all tests across workspaces
- `pnpm typecheck` - all packages
- `pnpm build` - all packages (also runs `lingui:compile` for the
  dashboard)
- `pnpm --filter @braiins-hashrate/dashboard run lingui:extract`
    - re-extract translation strings from source after edits

`docs/spec.md` is the project's design document - read the relevant section before changing how the controller 
behaves. `docs/research.md` captures empirical findings about the Braiins marketplace that we learned the hard way 
(e.g. that it's pay-your-bid, not CLOB - this matters for any pricing change).

## Forks

Forks are a feature, not a problem. If you maintain a fork:

- Please give it a different name in the dashboard (the `Hashrate Autopilot` brand stays here). The MIT license lets 
  you fork the code; the name is yours to change.
- If your fork has its own issues, route your users there. I'll redirect anything that lands in this tracker about a 
  fork I don't maintain.
- I'm happy to merge upstream-relevant changes from your fork. Open a PR or talk to me first if it's a substantial diff.

## Commit and PR style

- Match the existing commit style (look at recent `git log`). Imperative subject, body explains the "why", focused 
  diffs.
- One logical change per commit when reasonable.
- For PRs: describe what changes, why, and how you tested. Link the issue if it has one.

## License and DCO

By contributing, you agree your changes are released under the project's MIT license (see [LICENSE](LICENSE)). I 
don't require a formal CLA or DCO sign-off, but a `Signed-off-by:` line in your commit is welcome.

## Anything else

If something here is unclear or feels arbitrary, open a Discussion and tell me. The point of this document is to set 
expectations both ways - if it's failing at that, I'd rather know.