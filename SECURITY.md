# Security policy

## Reporting a vulnerability

Hashrate Autopilot is a Bitcoin tool, so I take security reports
seriously. **Please don't post exploits, suspected vulnerabilities,
or anything that could enable an attack against another operator's
funds in public issues, public discussions, pull requests, or any
public channel.**

Use one of these instead:

- **GitHub's private vulnerability reporting feature.** From this
  repo's Security tab, click "Report a vulnerability." That opens a
  private channel between you and me with the same workflow as a
  normal issue but invisible to anyone else. Preferred.
- **Email**: `rdouma@cygno.com`. Encrypt if you'd like; I can share
  a PGP key on request.

I'll confirm I've read your report within a few days. If your report
is reproducible and I agree it's a real vulnerability, I'll work on a
fix and coordinate disclosure with you - typically a private patch,
followed by a public release with a credit if you want one.

This is a hobby project run by one person in their spare time. I try
to respond soon, but I'm not on it 24/7 and there's no service-level
agreement attached to any of this. If a report is critical and you
haven't heard back in a week, feel free to ping the email again or
ask in a (non-exploit) public issue whether I've seen anything.

## What's in scope

- The autopilot daemon itself (`packages/daemon/**`)
- The dashboard (`packages/dashboard/**`) and the auth flow
- The Umbrel community-store package (`rdouma-hashrate-autopilot/**`)
- The Docker image published to `ghcr.io/rdouma/hashrate-autopilot`
- The setup wizard's secret-handling paths

## What's out of scope

- Vulnerabilities in upstream dependencies that aren't reachable in
  any default code path - report those directly to the dependency.
- Misconfiguration of an operator's own environment (publicly
  exposing the dashboard without a reverse proxy, weak passwords on
  the wizard step, etc.). The default Umbrel install routes through
  `app_proxy` and is fine; deliberately bypassing that is on you.
- The Braiins Hashpower API itself, the Ocean pool, or any other
  third-party service the autopilot consumes - report those to their
  respective vendors.
- Forks of this repository. If a fork has a vulnerability, contact
  the fork's maintainer.

## Coordinated disclosure

If you'd like a CVE assigned, GitHub's vulnerability advisories can
do that as part of the private flow. Otherwise we'll just publish a
patch and a CHANGELOG note.

Thank you for taking the time to report responsibly.
