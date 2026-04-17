# Exposing the Datum Gateway API on Umbrel

> **Status:** researched 2026-04-16, not yet applied. Steps verified
> against the live Umbrel box (192.168.1.121) but the port change has
> NOT been made yet — Datum has connected clients and should only be
> restarted during a planned maintenance window.

## Background

The hashrate dashboard wants to read Datum Gateway's own hashrate
estimate alongside what Braiins reports, so the operator can see both
perspectives on the same chart. Datum exposes an HTTP API with a
`/umbrel-api` endpoint that returns JSON with connection count and
hashrate — but the Umbrel app package only maps the stratum port
(23334) to the host network. The API port is live inside the Docker
container but unreachable from the LAN.

## What we found

### Network topology

```
Daemon machine   192.168.1.166  (remco's Mac, runs the autopilot)
Umbrel node      192.168.1.121  (runs Datum in Docker)
Stratum port     23334          (port-forwarded, reachable publicly
                                 via alkimia.mynetgear.com:23334)
Datum API port   21000 inside   (Umbrel's packager overrode the
                 the container   default 7152 → 21000 to match the
                                 app-proxy config)
```

### Datum config on the Umbrel box

Path: `/home/umbrel/umbrel/app-data/datum/data/settings/datum_gateway_config.json`

Relevant excerpt:
```json
"api": {
    "listen_port": 21000,
    "modify_conf": true,
    ...
}
```

### Docker compose (official Umbrel app)

Path: `/home/umbrel/umbrel/app-data/datum/docker-compose.yml`
Source: https://github.com/getumbrel/umbrel-apps/blob/master/datum/docker-compose.yml

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: datum_datum_1
      APP_PORT: 21000       # app-proxy routes to container's 21000

  datum:
    image: ghcr.io/retropex/datum:v1.14
    ports:
      - 23334:23334         # stratum only — API NOT exposed
```

The `app_proxy` container (port 21000 on the host) reverse-proxies
to the Datum container's port 21000 — but adds Umbrel's
authentication layer, which redirects unauthenticated requests to
the Umbrel login page. Not usable for machine-to-machine API calls.

### Containers running

```
ebf2b668e7f2  getumbrel/tor:0.4.7.8      datum-tor_server-1
cb0d8718b8eb  ghcr.io/retropex/datum:v1.14  datum_datum_1
              ports: 0.0.0.0:23334->23334/tcp
a9f4bbb1ab03  getumbrel/app-proxy:1.0.0    datum_app_proxy_1
              ports: 0.0.0.0:21000->21000/tcp
```

### API endpoint shape

`/umbrel-api` returns JSON (confirmed via Insomnia from the LAN):

```json
{
  "type": "three-stats",
  "items": [
    {"title": "Connections", ...},
    {"title": "Hashrate", ...}
  ]
}
```

Hashrate is in Th/s. The daemon will convert to PH/s (÷ 1000) for
the chart.

## The fix (one-time, ~2 minutes, requires Datum restart)

### Prerequisites

- SSH access to the Umbrel box (`ssh umbrel@192.168.1.121`)
- Root privileges (`sudo su`)
- A maintenance window where restarting Datum is acceptable (connected
  miners will briefly disconnect and auto-reconnect)

### Step 1 — Edit the compose file

Map the container's internal API port (21000) to a free host port
(7152). This bypasses the app-proxy auth layer and gives the daemon
direct LAN access.

```bash
sed -i 's/- 23334:23334/- 23334:23334\n      - 7152:21000/' \
  /home/umbrel/umbrel/app-data/datum/docker-compose.yml
```

### Step 2 — Verify the edit

```bash
cat /home/umbrel/umbrel/app-data/datum/docker-compose.yml
```

Expected result — the `ports` section should now read:

```yaml
    ports:
      # datum gateway port
      - 23334:23334
      - 7152:21000
```

### Step 3 — Restart the Datum container

```bash
cd /home/umbrel/umbrel
docker compose -f /home/umbrel/umbrel/app-data/datum/docker-compose.yml up -d datum
```

Connected miners will see a brief disconnect (~5–10 s) and
auto-reconnect. No configuration change on the miner side is needed.

### Step 4 — Verify from the daemon's machine

```bash
curl -s http://192.168.1.121:7152/umbrel-api | python3 -m json.tool
```

Should return the three-stats JSON with Connections and Hashrate.

### Step 5 — Configure the autopilot

In the dashboard's Config page, set:

```
Datum API URL: http://192.168.1.121:7152
```

(This config field will be added as part of the implementation;
it doesn't exist yet.)

## Caveat: Umbrel app updates

When Umbrel updates the Datum app, it may overwrite the
`docker-compose.yml` and remove the `7152:21000` port mapping.
If the Datum hashrate line disappears from the chart after an
update, re-apply step 1–3.

A more durable alternative would be to use a Docker Compose
override file (`docker-compose.override.yml` in the same
directory), which survives app updates:

```yaml
# /home/umbrel/umbrel/app-data/datum/docker-compose.override.yml
services:
  datum:
    ports:
      - 7152:21000
```

Whether Umbrel honours override files depends on the version. If
it does, this is the cleaner long-term solution.

## What the daemon will do once the API is reachable

1. New config field `datum_api_url` (nullable, default empty).
2. New service `services/datum.ts` that polls `/umbrel-api` every
   tick, parses the hashrate from the JSON, converts Th/s → PH/s.
3. New column `datum_hashrate_ph REAL` in `tick_metrics` (migration).
4. Hashrate chart gains a third line: "datum" (dashed, distinct
   colour) alongside "delivered" (Braiins) and the existing
   target/floor references. Both perspectives on the same axis so
   discrepancies are immediately visible.
5. Status card shows the Datum-reported hashrate alongside Braiins's
   figure for a quick sanity check.

## Future: Pool & Datum statistics panel

Once the Datum API is exposed, the current minimal "Pool" card
(which only shows "reachable" + uptime) could grow into a richer
statistics panel. Ideas to explore:

- **Datum-reported hashrate** vs Braiins-reported — plotted on the
  hashrate chart as a third line so discrepancies are visible.
- **Connected workers** count from Datum (active miners on your
  gateway).
- **Block finder detection** — poll `GET /v1/blocks/0/5/0` from
  the Ocean API periodically. Each block includes `username` (BTC
  address) + `workername`. If the operator's `btc_payout_address`
  matches, surface a celebratory notification on the dashboard.
  At ~1-2 PH/s vs Ocean's ~12.7 EH/s, odds per block are ~1 in
  12,700 — rare but worth celebrating when it hits.
- **Share rejection rate** from Datum (accepted vs rejected shares).
- **Upstream latency** — Datum knows the round-trip time to Ocean's
  stratum endpoint.

None of this requires Braiins API changes — it's all Datum-local
or Ocean public API. The bottleneck is the port-7152 exposure
documented above.

## Probe script

A ready-to-run probe script exists at `scripts/probe-datum.ts`:

```bash
DATUM_HOST=192.168.1.121 DATUM_PORT=7152 pnpm tsx scripts/probe-datum.ts
```

Use this after applying the fix to confirm the API is reachable
from the daemon's machine and to inspect the JSON shape.
