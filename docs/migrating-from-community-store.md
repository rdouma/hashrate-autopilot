# Migrating from the community store version

> **Audience:** anyone currently running **Hashrate Autopilot from the community app store** (Umbrel app id `rdouma-hashrate-autopilot`) who wants to switch to the **official Umbrel App Store** version (app id `hashrate-autopilot`).
>
> If you installed Hashrate Autopilot only after it appeared in the official store, this page does not apply to you.

## TL;DR

```bash
# Stop the community version (preserves data)
umbreld client apps.stop.mutate --appId rdouma-hashrate-autopilot

# Install Hashrate Autopilot from the official App Store via the Umbrel UI.
# It creates an empty fresh data dir.

# Stop the newly installed official version so the database isn't in use
umbreld client apps.stop.mutate --appId hashrate-autopilot

# Copy your live state.db over
sudo cp ~/umbrel/app-data/rdouma-hashrate-autopilot/data/state.db \
        ~/umbrel/app-data/hashrate-autopilot/data/state.db

# Start the official version against your migrated data
umbreld client apps.start.mutate --appId hashrate-autopilot

# Once the dashboard reads your history, free the disk (optional)
umbreld client apps.uninstall.mutate --appId rdouma-hashrate-autopilot
```


## Why is this even necessary?

Umbrel community app stores are required to prefix every app id with the store's own prefix. My community store ([rdouma/hashrate-autopilot](https://github.com/rdouma/hashrate-autopilot)) calls the app `rdouma-hashrate-autopilot`. The official Umbrel App Store has no prefix convention - there it's just `hashrate-autopilot`.

Umbrel stores every app's persistent data under `~/umbrel/app-data/<app-id>/`. Because the two app ids differ, **Umbrel treats the two installs as two different apps**:

| What you have | App id | Data lives in |
|---|---|---|
| Community store install | `rdouma-hashrate-autopilot` | `~/umbrel/app-data/rdouma-hashrate-autopilot/data/` |
| Official store install | `hashrate-autopilot` | `~/umbrel/app-data/hashrate-autopilot/data/` |

If you just click **Install** in the official store while keeping the community version, you end up with two instances running side by side, the new one with an empty database. If you uninstall the community version after installing the official one without migrating, your history goes with it.

The Docker image is identical (at the time of writing, both installs pull `ghcr.io/rdouma/hashrate-autopilot:1.13.0`),
so the only thing that has to move between the two on-host directories is the SQLite database. That's what the steps below do.

## Step by step

> **Back up `state.db` first if you have anything more than a few weeks of history.** Nothing in these steps is destructive, but a copy onto your laptop or a USB drive is cheap insurance. From your laptop: `scp umbrel@umbrel.local:~/umbrel/app-data/rdouma-hashrate-autopilot/data/state.db ~/state.db.backup`

### 1. Stop the community version

SSH into your Umbrel and run:

```bash
umbreld client apps.stop.mutate --appId rdouma-hashrate-autopilot
```

This brings the container down cleanly. Your data stays put under `~/umbrel/app-data/rdouma-hashrate-autopilot/`
(stopping is not uninstalling).

### 2. Install the official version

Open Umbrel's App Store in your browser, find **Hashrate Autopilot**, and install it. Wait for the install to complete and the app to boot once. This is what creates the fresh `~/umbrel/app-data/hashrate-autopilot/data/` directory with the correct ownership for the daemon to write to.

You will see the setup wizard instead of the dashboard if you open it. That's expected, since you haven't migrated yet.

### 3. Stop the official version

Back in the SSH session:

```bash
umbreld client apps.stop.mutate --appId hashrate-autopilot
```

SQLite likes the database file not to be open by another process when copied. Stopping the app guarantees that.

### 4. Copy `state.db` over

```bash
sudo cp ~/umbrel/app-data/rdouma-hashrate-autopilot/data/state.db \
        ~/umbrel/app-data/hashrate-autopilot/data/state.db
```

`sudo` is required because the daemon container runs as root, so the on-host data directory and its files are root-owned. The new file ends up root-owned too, which is exactly what the next container start expects.

### 5. Start the official version

```bash
umbreld client apps.start.mutate --appId hashrate-autopilot
```

Open the dashboard. You should see your full history - bids, ticks, alerts, config - exactly as it was on the community version.

### 6. Verify, then uninstall the community version (optional)

Spend a few minutes on the dashboard confirming everything is there. Once you're satisfied all went well, the community 
version is just taking up disk space and can be uninstalled:

```bash
umbreld client apps.uninstall.mutate --appId rdouma-hashrate-autopilot
```

This wipes `~/umbrel/app-data/rdouma-hashrate-autopilot/` and removes the community-store entry from your installed apps list.

## If something goes wrong

The community version's data stays where it was throughout this whole flow. Even if step 4 or 5 fails for any reason, you can always go back:

```bash
umbreld client apps.start.mutate --appId rdouma-hashrate-autopilot
```

…and you're back where you started, on the community version, with all your data intact. The official version's empty data dir under `~/umbrel/app-data/hashrate-autopilot/data/` is harmless; you can uninstall the official version through the Umbrel UI if you want a clean slate before trying again.

If you run into issues, the [Migration discussion thread](https://github.com/rdouma/hashrate-autopilot/discussions/286)
is the place to post what you ran and what you saw. 
Include the output of `ls -la ~/umbrel/app-data/rdouma-hashrate-autopilot/data/` 
and `ls -la ~/umbrel/app-data/hashrate-autopilot/data/` please.