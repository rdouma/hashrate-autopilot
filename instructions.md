# Hashrate Autopilot on StartOS

Open the web interface after the service starts and complete the setup wizard.

You will need:

- Braiins Hashpower marketplace API credentials.
- A public pool destination that Braiins can reach, usually your Datum Gateway stratum endpoint.
- A BTC payout address for Ocean.
- A dashboard password.

This package stores all service state in the StartOS `main` volume mounted at `/app/data`. Back up the service before uninstalling or rebuilding if you want to preserve configuration, secrets, tick history, bid history, and alerts.

The package declares Bitcoin, Electrs, and Datum as dependencies. StartOS dependency declarations warn when they are missing or stopped; they do not block the service from starting. If automatic defaults do not match your local service ports, override the Datum, Electrs, and Bitcoin RPC fields in the setup wizard or Config page.

The dashboard is served by the daemon itself and keeps its own Basic Auth. StartOS exposes the UI through the service interface.
