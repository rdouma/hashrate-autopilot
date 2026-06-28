# Exposing the Datum Gateway API on Umbrel

> **Status:** **WORKING**, but **every Datum app update reverts this and
> the Datum panel goes blank again** (confirmed 2026-06-28 - the
> nofile-limits hotfix #5263 regenerated `docker-compose.yml` and wiped
> the manual port mapping). This is the single most common way the
> integration breaks. If your Datum hashrate stops updating right after
> you updated the Datum app, that's this - just re-apply the edit. Two
> methods below: the direct port mapping (Method A) and disabling the
> app-proxy auth (Method B, cleaner, what the latest incident used).
> Both edit the same `docker-compose.yml`, so both get reverted on the
> next app update. See "What NOT to do" before improvising.

> **Why it breaks at all:** the official Umbrel Datum app only publishes
> stratum (`23334`) to the host; the HTTP API lives on container port
> `21000` behind Umbrel's auth-proxy, which 302-redirects unauthenticated
> machine requests to the login page. So an off-Umbrel autopilot can't
> reach it until you either expose the API port directly or turn the
> proxy auth off.

## Background

The hashrate dashboard wants to read Datum Gateway's own hashrate
estimate alongside what Braiins reports, so the operator can see both
perspectives on the same chart. Datum exposes an HTTP API with a
`/umbrel-api` endpoint that returns JSON with connection count and
hashrate - but the Umbrel app package only maps the stratum port
(23334) to the host network. The API port is live inside the Docker
container but unreachable from the LAN.

Despite the name, `/umbrel-api` is a **Datum Gateway** endpoint, not
an Umbrel-side proxy. It's defined in
[`datum_gateway/src/datum_api.c`](https://github.com/OCEAN-xyz/datum_gateway/blob/master/src/datum_api.c)
under `#ifdef DATUM_API_FOR_UMBREL` - the Umbrel Datum image
(`ghcr.io/retropex/datum:v1.14`) is built with that flag, so the
endpoint lives in the Datum process itself. Umbrel just renders the
JSON it returns into the small stats widget on the app card. The
default Datum API port is 7152; the Umbrel image rewires that to
container port 21000 internally to fit Umbrel's app-proxy
convention, which is why the host:7152 → container:21000 mapping
below works.

The fix is a one-line edit to the Datum app's `docker-compose.yml`
to add a second host→container port mapping, followed by a full
umbrelOS reboot so Docker re-reads the file.

## Network topology

```
Daemon machine   192.168.1.166  (operator's Mac, runs the autopilot)
Umbrel node      192.168.1.121  (runs Datum in Docker)
Stratum port     23334          (port-forwarded, reachable publicly
                                 via a DDNS hostname:23334)
Datum API port   21000 inside   (Umbrel's packager overrode the
                 the container   default 7152 → 21000 to match the
                                 app-proxy config)
Exposed API port 7152           (what this doc adds - maps host:7152
                                 → container:21000, bypassing the
                                 app-proxy auth layer)
```

## Datum config on the Umbrel box

Path: `/home/umbrel/umbrel/app-data/datum/data/settings/datum_gateway_config.json`

Relevant excerpt:
```json
"api": {
    "listen_port": 21000,
    "modify_conf": true,
    ...
}
```

## Docker compose (official Umbrel app)

Path: `/home/umbrel/umbrel/app-data/datum/docker-compose.yml`

The stock file exposes only the stratum port:

```yaml
services:
  datum:
    image: ghcr.io/retropex/datum:v1.14
    ports:
      - '23334:23334'         # stratum only - API NOT exposed
```

The `app_proxy` container (port 21000 on the host) reverse-proxies
to the Datum container's port 21000 - but adds Umbrel's
authentication layer, which redirects unauthenticated requests to
the Umbrel login page (port 2000). Not usable for machine-to-machine
API calls. That's why we add a direct `7152:21000` mapping instead.

## Method A - direct port mapping (~2 minutes, requires a full umbrelOS reboot)

### Prerequisites

- SSH access to the Umbrel box (`ssh umbrel@<umbrel-ip>`). On
  umbrelOS 1.5, SSH is disabled by default - enable it via
  Settings → Advanced → SSH before starting.
- Root privileges (`sudo su`).
- A maintenance window where a full Umbrel reboot is acceptable
  (bitcoind, LND, and all apps briefly go offline; bitcoind may do
  a short chainstate verification on restart).

### Step 1 - Edit the compose file

Add a second port mapping under the `datum` service. Use this exact
`sed` - the pattern matches the quoted form that umbrelOS 1.5
actually writes:

```bash
sed -i "s/- '23334:23334'/- '23334:23334'\n      - '7152:21000'/" \
  /home/umbrel/umbrel/app-data/datum/docker-compose.yml
```

### Step 2 - Verify the edit

```bash
cat /home/umbrel/umbrel/app-data/datum/docker-compose.yml
```

The `ports:` block under the `datum` service must now read:

```yaml
    ports:
      - '23334:23334'
      - '7152:21000'
```

If the file is unchanged, the pattern did not match - check that
the existing line really is `- '23334:23334'` with single quotes.

### Step 3 - Reboot the Umbrel

**Do this via a full OS reboot, not `umbreld apps.restart`.** See
the "What NOT to do" section below for why. Two options:

- **Preferred:** Umbrel dashboard → Settings → **Restart** button.
- **Fallback** (only if the dashboard is unresponsive): press and
  hold the physical power button ~10 seconds until it powers off,
  wait 30 seconds, power back on.

Plan for ~5-15 minutes of downtime. bitcoind will do a short
chainstate verification and then all apps will come up cleanly.

### Step 4 - Verify from the daemon's machine

```bash
curl -s http://192.168.1.121:7152/umbrel-api | python3 -m json.tool
```

Expected response:

```json
{
    "type": "three-stats",
    "refresh": "30s",
    "items": [
        {"title": "Connections", "text": "1", "subtext": "Worker"},
        {"title": "Hashrate", "text": "0.00", "subtext": "Th/s"}
    ]
}
```

The hashrate unit is in `subtext` and switches by magnitude - Datum
prints `Th/s` below ~1 PH/s and `Ph/s` above. The daemon reads the
unit each poll and converts to PH/s accordingly.

### Step 5 - Configure the autopilot

In the dashboard Config page (or `config.json`), set:

```
Datum API URL: http://192.168.1.121:7152
```

Leaving this empty disables the integration - the dashboard shows
a "Datum not configured" empty state and the daemon records nothing
for Datum hashrate. This is intentional: the integration is
informational-only and fully optional.

## Method B - disable the app-proxy auth (alternative, no reboot)

Instead of adding a direct port mapping, tell Umbrel's app-proxy not to
gate the Datum API and point the daemon at the existing `21000` proxy
port. This is what the 2026-06-28 recovery used - a one-line env change
and a normal app restart, no full OS reboot.

Edit the **`app_proxy`** service's environment in the Datum app's
`docker-compose.yml`:

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: datum_datum_1
      APP_PORT: 21000
      PROXY_AUTH_ADD: "false"        # <- add this line
```

To keep the Datum dashboard behind Umbrel login and open only the stats
path, leave `PROXY_AUTH_ADD: "true"` and add
`PROXY_AUTH_WHITELIST: "/umbrel-api"` instead.

Restart the app, then confirm and configure:

```bash
sudo ~/umbrel/scripts/app restart datum    # or stop+start from the Umbrel UI
curl -s http://<umbrel-ip>:21000/umbrel-api | python3 -m json.tool   # expect JSON, not a 302
```

Set **Datum API URL** to `http://<umbrel-ip>:21000` (base only; the
daemon appends `/umbrel-api`).

Trade-offs vs Method A: no extra port and no full reboot, but
`PROXY_AUTH_ADD: "false"` drops auth on the whole Datum app on the LAN
(Method A's direct mapping is also unauthenticated, so neither is more
exposed - only the `PROXY_AUTH_WHITELIST` variant keeps the dashboard
behind login). Same caveat as Method A: an app update reverts it.

## ⚠️ What NOT to do

Two things went sideways during the first live attempt on
2026-04-19. Both have since been fixed in this doc, but they're
worth flagging for anyone improvising.

### Don't use `umbreld client apps.restart.mutate`

On umbrelOS 1.5 this does **not** simply bounce the container. It
re-provisions the app, which regenerates `docker-compose.yml` from
the app-store metadata and wipes any manual edits. In the
2026-04-19 attempt it also hung indefinitely, held system-wide
locks, and made the entire Umbrel unresponsive (no SSH, no HTTP,
no ping). A hard power-cycle was needed to recover.

Use the dashboard **Restart** button (or a cold-boot as last
resort) for a full OS reboot instead. Docker re-reads the compose
file on its own process startup - no app-level re-provisioning
needed.

### Don't use unquoted `sed` patterns

The stock compose file on umbrelOS 1.5 uses single-quoted port
strings (`- '23334:23334'`), not the unquoted form the original
research notes used. An unquoted `sed` pattern silently no-op's -
`sed` returns success, but the file is unchanged. Always `cat` the
file after the edit to verify the new line is really there.

### Don't use raw `docker compose up -d` to restart the app

Running `docker compose -f /home/umbrel/umbrel/app-data/datum/docker-compose.yml up -d datum`
directly fails on umbrelOS 1.5 because `app_proxy` in that compose
has no `image` field (umbreld injects it at runtime) and
`APP_DATA_DIR` isn't set outside umbreld's invocation environment.
A full OS reboot is the simplest correct restart.

## Caveat: Umbrel app updates

When Umbrel updates the Datum app, it may overwrite
`docker-compose.yml` and remove the `7152:21000` mapping. If the
Datum hashrate stops updating after an app update, re-apply step 1
and reboot.

A more durable alternative may be a Docker Compose override file:

```yaml
# /home/umbrel/umbrel/app-data/datum/docker-compose.override.yml
services:
  datum:
    ports:
      - '7152:21000'
```

Whether umbrelOS honours override files across app updates has
not yet been verified - the direct edit is known to work within a
given app version, and that's enough for now.

## What the daemon does with the API

1. Config field `datum_api_url` (nullable string, default null -
   integration is disabled when unset).
2. Service `packages/daemon/src/services/datum.ts` polls
   `{datum_api_url}/umbrel-api` each tick, parses the three-stats
   JSON, extracts connection count and hashrate (Th/s), and
   converts hashrate to PH/s.
3. Column `datum_hashrate_ph REAL` on `tick_metrics` (migration
   0029) stores the per-tick Datum-reported hashrate, null when
   the integration is disabled or the poll failed.
4. The Pool card on the Status page is replaced by a Datum panel
   showing reachability, connected workers, and Datum-reported
   hashrate - with a "not configured" empty state when
   `datum_api_url` is null.

## Probe script

A ready-to-run probe script exists at `scripts/probe-datum.ts`:

```bash
DATUM_HOST=192.168.1.121 DATUM_PORT=7152 pnpm tsx scripts/probe-datum.ts
```

Use this after applying the fix to confirm the API is reachable
from the daemon's machine and to inspect the JSON shape.
