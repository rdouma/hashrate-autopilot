# Changelog

## 2026-05-29

### `[Fix]` Pool-luck step tooltip wording (#223)

The pool-luck step tooltip on the Hashrate chart was labelling the luck value as the "numerator" - e.g. "Block aged out of the rolling-24h window - numerator went from 1.14× to 0.91×." The numerator of the luck formula is actually the block count over the rolling window (an integer, N → N±1); the 1.14× / 0.91× values shown are the pool luck multiplier before and after the step. Reworded to "pool luck went from X× to Y×" on both step-up (block landed) and step-down (block aged out) variants. en / nl / es catalogs updated.

### `[Infra]` Reverted: profit per bucket overlay on the Price chart (#220)

The signed-bar profit overlay shipped on 2026-05-27 read as visually busy on the Price chart and didn't communicate net profit clearly when overlaid on top of the existing bid / fillable / hashprice / max-bid lines and the cube / pickaxe / fuel / gem markers above. Cancelled per operator review. The same chart slot is still available for a future profit visualisation; a line series (matching the existing right-axis pattern) is a more promising shape than bars if the idea is revisited.

### `[Fix]` Pool-block dots on the unpaid line now correctly match distinct Ocean refresh steps (#221)

When two pool blocks were found close together (within ~10 minutes), the per-block dot-projection loop on the Price chart's unpaid line restarted its baseline read from `cursor - 1` for every block. Block 2's scan would re-find the same first step block 1 had already claimed - so both dots projected to the same `(cx, cy)` even when the unpaid line had two distinct step-ups (e.g. `970k → 1.00M` for block 1, then `1.00M → 1.04M` for block 2). On the chart this looked like a single dot at the wrong (intermediate) height, and the second block's tooltip was unreachable. Now: the scan tracks a `scanFromIdx` that advances past each block's claimed step, so block N+1's baseline starts from the post-step plateau of block N. Distinct steps each get their own dot at the correct post-step Y. The genuine Ocean-batched case (block N+1's forward scan finds no further step) still inherits block N's anchor, with an 8-pixel horizontal stagger so multiple dots at one step remain individually hoverable.

## 2026-05-26

### `[Release]` v1.9.0

On-chain payout gems, Braiins deposit fuel markers with balance step-up connectors, BIP 110 activation progress bar with MASF/UASF tooltip, Braiins balance right-axis series, pool-probe error exposure, rich BIP 110 scan cards, and chart viewport/axis fixes. New migrations 0095-0098.

### `[UI]` Deposit markers and connectors in purple (#211)

Deposit fuel icons changed from amber to purple to match the Braiins balance line. When the right axis shows Braiins balance, a purple dot appears on the balance line at the step-up caused by each deposit, with a dotted connector line back to the fuel icon. Hovering either the dot or the connector opens the deposit tooltip.

### `[UI]` BIP 110 activation progress bar

The BIP 110 scan card now includes an inline progress bar showing the current signaling ratio against the 95% activation threshold. A tooltip explains the two-phase activation path: the current MASF (miner-activated soft fork) phase where miners signal readiness via version bits, and the UASF (user-activated soft fork) enforcement that activates unconditionally at block height 965,664 (~September 2026).

### `[UI]` Pool luck step-down tooltip shows from/to values

When a pool block ages out of the trailing luck window, the step-down tooltip now shows the previous and new luck values (e.g. "went from 1.42x to 1.18x"), matching the step-up format used when new blocks arrive.

## 2026-05-25

### `[Feature]` Pool-probe error in dashboard tooltip and daemon log (#212)

When the stratum probe fails, the dashboard now shows the actual error (e.g. "timeout after 2500ms", "connect ECONNREFUSED") as a tooltip on the "stratum DOWN" badge. When the probe succeeds, the tooltip shows latency in ms. Probe failures are also logged to the daemon console at warn level for post-mortem analysis.
