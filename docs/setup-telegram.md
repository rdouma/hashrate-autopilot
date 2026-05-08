# Setting up Telegram notifications

> **Status:** Live on the v1.6.0 branch (#100). The notifier polls
> Telegram's centralised API; both bot creation and chat lookup go
> through standard Telegram tooling. No daemon code changes are
> required to add or replace the bot.

## Background

The dashboard's `/alerts` page records every notification the daemon
fires, but recording isn't push - the operator has to actually look
at the page. For "the stratum server died at 3am" you want a phone
ringing, not a dashboard glance. v1.6.0 wires Telegram as the
external push channel: the daemon POSTs alert bodies to
`https://api.telegram.org/bot{token}/sendMessage` with a 10-second
timeout, retries up to 5 times if delivery fails or the bad state
persists, and pairs an INFO recovery message when the underlying
state clears.

Why Telegram over Nostr DMs / email / ntfy:

- **Setup friction**: @BotFather is a 60-second flow that any
  Telegram user can complete. Nostr requires picking a client,
  picking a relay, generating keys, configuring push.
- **Push reliability**: Telegram's centralised server pushes via
  Apple/Google's notification infrastructure, which is the
  battle-tested path for "wake the operator's phone at 3am."
- **Sovereignty trade-off**: Telegram is a centralised messenger,
  which conflicts with the rest of the stack's
  (own-node / own-Datum / own-Knots) sovereignty bias. Accepted
  because the goal here is a phone alarm, not ideological
  consistency. The notifier is structured around a
  `NotificationSink` interface so a future Nostr / ntfy backend
  can slot in without re-wiring detectors.

## Step 1: create a Telegram bot via @BotFather

1. Open Telegram and search for **@BotFather** (the official
   verified bot account - blue checkmark next to the name).
2. Send `/newbot`. @BotFather will ask for a name and a username.
   - Name: anything you'll recognise, e.g. `Hashrate Autopilot`.
   - Username: must end in `bot` and be globally unique, e.g.
     `my_hashrate_autopilot_bot`. Telegram will tell you if the name
     is taken.
3. @BotFather replies with the **bot token** - a string like
   `123456789:AAEhBP0av28v...`. Copy it. **Treat it as a secret:**
   anyone with this token can post messages as your bot.

## Step 2: get your chat ID

The bot can only send to chats it has been started with. There are
two paths:

**Path A (one-on-one chat with the bot):**

1. Open the Telegram app and search for the bot username you just
   created.
2. Click "Start" - this both opens the chat and registers your user
   id with the bot.
3. Search for **@userinfobot** (an unaffiliated but widely-used
   utility bot that returns your numeric Telegram user id).
4. Send `/start` to @userinfobot. It replies with your numeric
   `Id: 123456789`. Copy that number - it's your chat id.

**Path B (group chat with the bot):**

1. Add your bot to a group, then send a message in the group.
2. Visit
   `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` in a browser
   (substitute your token).
3. Look for `"chat":{"id": -123456789, ...}` in the JSON response.
   Group chat ids are negative; that's normal. Use the negative number.

## Step 3: paste both into Config → Notifications

1. Open the dashboard and go to **Config → Notifications**.
2. Paste the bot token into the **Telegram bot token** field
   (password-masked).
3. Paste the chat id into the **Chat ID** field.
4. Click **Test connection**. The notifier sends:

   ```
   Hashrate Autopilot test message. If you see this, your bot
   token + chat id are wired correctly.
   ```

5. The button reports `OK · message delivered` next to itself, and
   you should see the message land on the configured Telegram
   chat within a few seconds.
6. **Click Save** to persist the values - the Test button validates
   the typed-but-unsaved values; saving is a separate explicit step
   (mirrors the Bitcoin Core RPC test flow).

## Step 4: verify retry / mute / snooze behaviour

Optional sanity check that the full alert pipeline works:

1. With the autopilot running LIVE, briefly stop your Datum gateway.
2. Wait `pool_outage_blip_tolerance_seconds × 5` (default 5 minutes).
3. The first LOUD alert should arrive on Telegram. The `/alerts`
   page records the row with `delivery_status: sent`.
4. Restart Datum. Within ~1 minute an INFO recovery message arrives
   (`Datum gateway reachable again - was down 5m`).
5. Toggle **Mute all Telegram notifications** on Config →
   Notifications. Stop Datum again. The next alert lands on
   `/alerts` with `delivery_status: muted`; no Telegram message
   fires. Toggle mute back off when done.
6. From the `/alerts` row's actions column, click `30m` snooze on
   an active alert. Subsequent retries within that window record
   as `snoozed`; recovery messages bypass snooze.

## Operational notes

- **Token rotation**: re-run /newtoken with @BotFather (or
  `/revoke` and create a fresh bot). Paste the new token into
  Config and click Save.
- **Bot blocked by user**: if you blocked your own bot in Telegram,
  the notifier's POST returns "bot was blocked by the user". Unblock
  via the bot's chat menu in the app.
- **Network firewall**: the daemon needs outbound HTTPS to
  `api.telegram.org`. Tailscale / VPN / corporate firewall
  configurations that block this will cause every alert to fail and
  go through the full retry ladder before giving up. Test
  connection surfaces the underlying error string verbatim
  (ENOTFOUND / ECONNREFUSED / etc.).
- **Multi-operator setups**: not yet supported. Single chat id per
  install. If multiple humans should be paged, use a group chat (Path
  B above).
- **Quiet hours**: not implemented; mute-on-demand replaces the use
  case. The `notifications_muted` toggle on Config silences
  everything; turn back on when you want to hear from the daemon
  again. There's no schedule.

## What's stored where

| Field | Storage | Editable from |
|---|---|---|
| `telegram_bot_token` | `config` table (live) + `secrets` (fallback) | Config page → Notifications |
| `telegram_chat_id` | `config` table | Config page → Notifications |
| `notifications_muted` | `config` table | Config page → Notifications |
| `notification_retry_interval_minutes` | `config` table | Config page → Notifications |
| Per-alert audit trail | `alerts` table | Read-only via /alerts page |

The bot token's dual location (config + secrets) mirrors the
Bitcoin Core RPC password pattern: the encrypted-at-rest secrets
file (`.env.sops.yaml`) is consulted as a fallback when the config
column is empty, so installs that bootstrapped via the SOPS path
keep working without a config edit. New installs and live edits
write to the config table.

## What if Telegram itself is down?

The retry ladder gives delivery up to ~2 hours of leeway (initial
attempt + 4 retries × 30 min). If Telegram is still unreachable
after the 5th attempt, the daemon sends a final "still bad after
2h. No further notifications until recovery." marker and goes
silent for that alert until either:

1. The underlying state clears (recovery message fires through
   normally if Telegram is back by then), or
2. The state transitions clear-then-bad-again - a fresh state
   change starts the retry ladder over with attempt #1.

This caps the worst-case spam at 5 messages per outage and 1
recovery, regardless of how flaky Telegram is on the way through.
