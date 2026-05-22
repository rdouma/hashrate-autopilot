/**
 * Daemon-side i18n catalog for Telegram alert copy (#131).
 *
 * The dashboard has a Lingui pipeline; the daemon does not. Rather
 * than pull `@lingui/core` into the daemon (cross-package extraction,
 * .po build steps, runtime locale loading), we ship a small typed
 * catalog of templates here. Every operator-facing string that
 * eventually lands in a Telegram message goes through this module.
 *
 * Structure: one `AlertCopy` object per supported locale, with one
 * function per (event_class, role) slot. Functions accept typed args
 * (sat amounts, durations, etc) and return the rendered string. This
 * keeps interpolation type-safe and lets the dashboard's locale-aware
 * formatters share the catalog later if we ever want to.
 *
 * Adding a new locale: copy the `en` block, translate, register in
 * `CATALOGS`. Adding a new event_class: add a method to `AlertCopy`,
 * translate in every locale, call from the alert evaluator with the
 * cfg's locale.
 */

export type AlertLocale = 'en' | 'nl' | 'es';

export const SUPPORTED_LOCALES: readonly AlertLocale[] = ['en', 'nl', 'es'];

export function isAlertLocale(s: string | null | undefined): s is AlertLocale {
  return s === 'en' || s === 'nl' || s === 'es';
}

/**
 * One method per slot. The naming convention is
 * `<event_class>_<role>` where role is `title` / `body` /
 * `title_recovery` / `body_recovery`. INFO-only events (no recovery
 * pair) just have title/body.
 */
export interface AlertCopy {
  // Severity prefix labels (rendered inside the Telegram body's
  // bold-prefix). RESOLVED is a presentation label for any recovery
  // row regardless of stored severity.
  prefix_important: string;
  prefix_warning: string;
  prefix_info: string;
  prefix_resolved: string;

  giving_up_body: string;

  datum_unreachable_title(): string;
  datum_unreachable_title_recovery(): string;
  datum_unreachable_body(args: { duration: string }): string;
  datum_unreachable_body_recovery(args: { duration: string }): string;
  marketplace_empty_title(): string;
  marketplace_empty_title_recovery(): string;
  marketplace_empty_body(args: { duration: string }): string;
  marketplace_empty_body_recovery(args: { duration: string }): string;

  hashrate_below_floor_title(): string;
  hashrate_below_floor_title_recovery(): string;
  hashrate_below_floor_body(args: {
    duration: string;
    actual_ph: string;
    floor_ph: string;
  }): string;
  hashrate_below_floor_body_recovery(args: { duration: string }): string;

  zero_hashrate_title(): string;
  zero_hashrate_title_recovery(): string;
  zero_hashrate_body(args: { duration: string }): string;
  zero_hashrate_body_recovery(args: { duration: string }): string;

  api_unreachable_title(): string;
  api_unreachable_title_recovery(): string;
  api_unreachable_body(args: { duration: string }): string;
  api_unreachable_body_recovery(args: { duration: string }): string;

  unknown_bid_title(): string;
  unknown_bid_title_recovery(): string;
  unknown_bid_body(args: { count: number; ids: string }): string;
  unknown_bid_body_recovery(): string;

  sustained_paused_title(): string;
  sustained_paused_title_recovery(): string;
  sustained_paused_body(args: { duration: string; reason: string }): string;
  sustained_paused_body_recovery(args: { duration: string }): string;

  beta_exit_title(): string;
  beta_exit_title_recovery(): string;
  beta_exit_body(args: { fee_pct: string }): string;
  beta_exit_body_recovery(): string;

  wallet_runway_title(args: { runway_days: string; threshold_days: string }): string;
  wallet_runway_title_recovery(args: { runway_days: string; threshold_days: string }): string;
  wallet_runway_body(args: {
    balance_sat: string;
    burn_per_day_sat: string;
    runway_days: string;
    threshold_days: number;
  }): string;
  wallet_runway_body_recovery(args: { runway_days: string; threshold_days: number }): string;

  pool_block_credited_title(args: { height: string; payout_btc: string | null }): string;
  pool_block_credited_body(args: {
    height: string;
    reward_btc: string;
    share_pct: string;
    credit: string;
    payout_sat: string | null;
    payout_btc: string | null;
    unpaid: string;
  }): string;

  // #130 - Braiins deposit lifecycle.
  braiins_deposit_detected_title(): string;
  braiins_deposit_detected_body(args: { amount: string; address_short: string | null }): string;
  braiins_deposit_available_title(): string;
  braiins_deposit_available_body(args: { amount: string }): string;
  braiins_deposit_returned_title(): string;
  braiins_deposit_returned_body(args: { amount: string; return_tx_short: string }): string;

  // #149 - solo-mining (Bitaxe / AxeOS) per-device alerts.
  solo_overheating_title(args: { label: string; temp_c: string; ceiling_c: string }): string;
  solo_overheating_title_recovery(args: { label: string }): string;
  solo_overheating_body(args: {
    label: string;
    temp_c: string;
    ceiling_c: string;
    duration: string;
  }): string;
  solo_overheating_body_recovery(args: { label: string; duration: string }): string;

  solo_zero_hashrate_title(args: { label: string }): string;
  solo_zero_hashrate_title_recovery(args: { label: string }): string;
  solo_zero_hashrate_body(args: { label: string; reason: string; duration: string }): string;
  solo_zero_hashrate_body_recovery(args: { label: string; duration: string }): string;

  solo_share_rejection_title(args: { label: string }): string;
  solo_share_rejection_body(args: {
    label: string;
    rate_pct: string;
    rejected: string;
    total: string;
    window_min: string;
  }): string;

  solo_stratum_drift_title(args: { label: string }): string;
  solo_stratum_drift_body(args: { label: string; old_url: string; new_url: string }): string;

  // #204 - solo fleet best difficulty.
  solo_best_difficulty_title(args: { difficulty: string }): string;
  solo_best_difficulty_body(args: { label: string; difficulty: string; previous: string | null; improvement: string | null }): string;
}

const EN: AlertCopy = {
  prefix_important: '🔴 [IMPORTANT]',
  prefix_warning: '⚠️ [WARNING]',
  prefix_info: 'ℹ️ [INFO]',
  prefix_resolved: '✅ [RESOLVED]',

  giving_up_body: 'Still bad after 2h. No further notifications until recovery.',

  datum_unreachable_title: () => 'Datum stratum unreachable',
  datum_unreachable_title_recovery: () => 'Datum stratum reachable',
  datum_unreachable_body: ({ duration }) =>
    `Datum gateway has been unreachable for ${duration}. Buyer-side hashrate cannot reach Ocean - shares are not crediting. The autopilot has cancelled the active bid to stop spend; it will resume bidding when stratum recovers.`,
  datum_unreachable_body_recovery: ({ duration }) =>
    `Datum gateway reachable again - was down ${duration}.`,

  marketplace_empty_title: () => 'Braiins marketplace empty',
  marketplace_empty_title_recovery: () => 'Braiins marketplace supply returned',
  marketplace_empty_body: ({ duration }) =>
    `The Braiins marketplace has had no hashrate available for your target for ${duration}. The autopilot is bidding but the orderbook has no asks that can fill it. Delivery is at zero. Nothing to do - this resolves when supply returns.`,
  marketplace_empty_body_recovery: ({ duration }) =>
    `Marketplace supply returned - was empty for ${duration}. Bids are filling again.`,

  hashrate_below_floor_title: () => 'Hashrate below floor',
  hashrate_below_floor_title_recovery: () => 'Hashrate above floor',
  hashrate_below_floor_body: ({ duration, actual_ph, floor_ph }) =>
    `Delivered hashrate has been below the configured floor for ${duration}. Current: ${actual_ph} PH/s; floor: ${floor_ph} PH/s.`,
  hashrate_below_floor_body_recovery: ({ duration }) =>
    `Hashrate back at or above floor - was below for ${duration}.`,

  zero_hashrate_title: () => 'Zero hashrate',
  zero_hashrate_title_recovery: () => 'Hashrate flowing again',
  zero_hashrate_body: ({ duration }) =>
    `No hashrate delivered for ${duration}. Likely the upstream marketplace stopped routing - check the active bid and fee state.`,
  zero_hashrate_body_recovery: ({ duration }) =>
    `Hashrate flowing again - was zero for ${duration}.`,

  api_unreachable_title: () => 'Braiins API unreachable',
  api_unreachable_title_recovery: () => 'Braiins API reachable',
  api_unreachable_body: ({ duration }) =>
    `The Braiins marketplace API has been unreachable for ${duration}. The autopilot cannot read orderbook / balance / fee data and is making no decisions until it recovers.`,
  api_unreachable_body_recovery: ({ duration }) =>
    `Braiins API reachable again - was down ${duration}.`,

  unknown_bid_title: () => 'Unknown bid detected',
  unknown_bid_title_recovery: () => 'Account clean (no unknown bids)',
  unknown_bid_body: ({ count, ids }) =>
    `${count} bid(s) in the Braiins account that the autopilot did not create: ${ids}. Daemon auto-paused per the unknown-order rule. Inspect via the Braiins dashboard before resuming LIVE.`,
  unknown_bid_body_recovery: () =>
    `Account is clean again - no unknown bids visible. Re-enable LIVE on the dashboard when ready.`,

  sustained_paused_title: () => 'Bid sustained-paused by Braiins',
  sustained_paused_title_recovery: () => 'Bid active again',
  sustained_paused_body: ({ duration, reason }) =>
    `Primary owned bid has been Paused by Braiins for ${duration} (last_pause_reason: ${reason}). Likely the Paused/Active oscillation hazard - check the destination pool / Datum gateway and consider a manual edit.`,
  sustained_paused_body_recovery: ({ duration }) =>
    `Primary bid no longer flagged Paused - was paused for ${duration}. (If the bid flips back to Paused right away, that's the documented Paused/Active oscillation hazard - Braiins toggles the flag while still routing hashrate.)`,

  beta_exit_title: () => 'Braiins beta-exit fees detected',
  beta_exit_title_recovery: () => 'Braiins beta-exit fees cleared',
  beta_exit_body: ({ fee_pct }) =>
    `Braiins is now charging a non-zero fee on at least one active bid (fee_rate_pct: ${fee_pct}%). The marketplace appears to have exited beta - re-evaluate the cost model and consider the documented beta-exit handling steps.`,
  beta_exit_body_recovery: () =>
    `Active bids are back to fee_rate_pct = 0. Either Braiins reverted, or all fee-bearing bids settled.`,

  wallet_runway_title: ({ runway_days, threshold_days }) =>
    `Wallet runway ${runway_days} days (below ${threshold_days} day threshold)`,
  wallet_runway_title_recovery: ({ runway_days, threshold_days }) =>
    `Wallet runway ${runway_days} days (above ${threshold_days} day threshold)`,
  wallet_runway_body: ({ balance_sat, burn_per_day_sat, runway_days, threshold_days }) =>
    `Total Braiins balance (available + blocked) is ${balance_sat} sat; trailing-3h burn is ${burn_per_day_sat} sat/day. At that rate the wallet hits zero in ${runway_days} days, below the configured ${threshold_days}-day threshold. Top up the Braiins wallet or lower the bid; without a top-up, bids will start cancelling for insufficient funds.`,
  wallet_runway_body_recovery: ({ runway_days, threshold_days }) =>
    `Wallet runway back above threshold: ${runway_days} days (threshold ${threshold_days}). Likely a top-up landed or the burn rate dropped.`,

  pool_block_credited_title: ({ height, payout_btc }) =>
    payout_btc
      ? `Pool block credited + ON-CHAIN PAYOUT - #${height}`
      : `Pool block credited - #${height}`,
  pool_block_credited_body: ({ height, reward_btc, share_pct, credit, payout_sat, payout_btc, unpaid }) =>
    `Ocean found pool block #${height} (reward ${reward_btc} BTC). Your share: ${share_pct} → ${credit}.${payout_sat && payout_btc ? ` Paid out: ${payout_sat} sat / ${payout_btc} BTC to your payout address.` : ''} Unpaid total: ${unpaid}.`,

  braiins_deposit_detected_title: () => 'Braiins deposit detected',
  braiins_deposit_detected_body: ({ amount, address_short }) =>
    `Braiins detected a deposit of ${amount}${address_short ? ` to ${address_short}...` : ''}. Funds normally clear after 3 confirmations and become spendable on the Braiins marketplace. In rare cases a compliance screening kicks in, which can add up to 48h before they're spendable.`,
  braiins_deposit_available_title: () => 'Braiins deposit available',
  braiins_deposit_available_body: ({ amount }) =>
    `Braiins compliance cleared a deposit of ${amount} - the funds are now spendable on the Braiins marketplace.`,
  braiins_deposit_returned_title: () => 'Braiins deposit returned',
  braiins_deposit_returned_body: ({ amount, return_tx_short }) =>
    `Braiins compliance has returned a deposit of ${amount}. Return tx: ${return_tx_short}. Check the Braiins dashboard for the rejection reason.`,

  solo_overheating_title: ({ label, temp_c, ceiling_c }) =>
    `Solo miner overheating: ${label} (${temp_c} °C ≥ ${ceiling_c} °C)`,
  solo_overheating_title_recovery: ({ label }) => `Solo miner cooled: ${label}`,
  solo_overheating_body: ({ label, temp_c, ceiling_c, duration }) =>
    `${label} has been at or above ${ceiling_c} °C (current ${temp_c} °C) for ${duration}. Check airflow / ambient temperature; the ASIC will throttle or shut down if it climbs further.`,
  solo_overheating_body_recovery: ({ label, duration }) =>
    `${label} back below the thermal ceiling - was overheating for ${duration}.`,

  solo_zero_hashrate_title: ({ label }) => `Solo miner offline: ${label}`,
  solo_zero_hashrate_title_recovery: ({ label }) => `Solo miner online: ${label}`,
  solo_zero_hashrate_body: ({ label, reason, duration }) =>
    `${label} has been ${reason} for ${duration}. Check the power supply / WiFi / pool config.`,
  solo_zero_hashrate_body_recovery: ({ label, duration }) =>
    `${label} reporting hashrate again - was offline for ${duration}.`,

  solo_share_rejection_title: ({ label }) => `Solo miner share-rejection high: ${label}`,
  solo_share_rejection_body: ({ label, rate_pct, rejected, total, window_min }) =>
    `${label} rejected ${rejected} of ${total} shares (${rate_pct} %) over the last ${window_min} min. Likely a stratum / freq / voltage misconfiguration.`,

  solo_stratum_drift_title: ({ label }) => `Solo miner stratum changed: ${label}`,
  solo_stratum_drift_body: ({ label, old_url, new_url }) =>
    `${label}'s stratum URL changed from ${old_url} to ${new_url}. If this wasn't you, someone re-pointed the device.`,

  solo_best_difficulty_title: ({ difficulty }) =>
    `New best difficulty: ${difficulty}`,
  solo_best_difficulty_body: ({ label, difficulty, previous, improvement }) =>
    `${label} submitted a share at ${difficulty} difficulty${improvement ? ` (${improvement}x improvement)` : ''}. ${previous ? `Previous record: ${previous}. ` : ''}`,
};

const NL: AlertCopy = {
  prefix_important: '🔴 [BELANGRIJK]',
  prefix_warning: '⚠️ [WAARSCHUWING]',
  prefix_info: 'ℹ️ [INFO]',
  prefix_resolved: '✅ [OPGELOST]',

  giving_up_body: 'Nog steeds slecht na 2u. Geen verdere notificaties tot herstel.',

  datum_unreachable_title: () => 'Datum stratum onbereikbaar',
  datum_unreachable_title_recovery: () => 'Datum stratum bereikbaar',
  datum_unreachable_body: ({ duration }) =>
    `Datum gateway is al ${duration} onbereikbaar. Gehuurde hashrate kan Ocean niet bereiken - shares worden niet bijgeschreven. De autopilot heeft het actieve bod geannuleerd om kosten te stoppen; bieden wordt hervat zodra stratum herstelt.`,
  datum_unreachable_body_recovery: ({ duration }) =>
    `Datum gateway is weer bereikbaar - was ${duration} down.`,

  marketplace_empty_title: () => 'Braiins-marktplaats leeg',
  marketplace_empty_title_recovery: () => 'Aanbod op de Braiins-marktplaats terug',
  marketplace_empty_body: ({ duration }) =>
    `Op de Braiins-marktplaats is al ${duration} geen hashrate beschikbaar voor je doel. De autopilot biedt wel maar er staat niets in de orderbook dat vervuld kan worden. Levering is nul. Niets te doen - dit lost zich op zodra er weer aanbod is.`,
  marketplace_empty_body_recovery: ({ duration }) =>
    `Aanbod op de marktplaats is terug - was ${duration} leeg. Biedingen worden weer vervuld.`,

  hashrate_below_floor_title: () => 'Hashrate onder de vloer',
  hashrate_below_floor_title_recovery: () => 'Hashrate boven de vloer',
  hashrate_below_floor_body: ({ duration, actual_ph, floor_ph }) =>
    `Geleverde hashrate ligt al ${duration} onder de geconfigureerde vloer. Huidig: ${actual_ph} PH/s; vloer: ${floor_ph} PH/s.`,
  hashrate_below_floor_body_recovery: ({ duration }) =>
    `Hashrate weer op of boven de vloer - was ${duration} onder.`,

  zero_hashrate_title: () => 'Geen hashrate',
  zero_hashrate_title_recovery: () => 'Hashrate stroomt weer',
  zero_hashrate_body: ({ duration }) =>
    `Geen hashrate geleverd in ${duration}. Waarschijnlijk routeert de marketplace niet meer - controleer de actieve bid en fee-status.`,
  zero_hashrate_body_recovery: ({ duration }) =>
    `Hashrate stroomt weer - was ${duration} nul.`,

  api_unreachable_title: () => 'Braiins API onbereikbaar',
  api_unreachable_title_recovery: () => 'Braiins API bereikbaar',
  api_unreachable_body: ({ duration }) =>
    `De Braiins marketplace-API is al ${duration} onbereikbaar. De autopilot kan orderbook / saldo / fee-data niet lezen en neemt geen beslissingen tot herstel.`,
  api_unreachable_body_recovery: ({ duration }) =>
    `Braiins API weer bereikbaar - was ${duration} down.`,

  unknown_bid_title: () => 'Onbekende bid gedetecteerd',
  unknown_bid_title_recovery: () => 'Account weer schoon (geen onbekende bids)',
  unknown_bid_body: ({ count, ids }) =>
    `${count} bid(s) in het Braiins-account die de autopilot niet heeft aangemaakt: ${ids}. Daemon is auto-PAUSED volgens de unknown-order regel. Inspecteer via de Braiins dashboard voordat je weer LIVE gaat.`,
  unknown_bid_body_recovery: () =>
    `Account is weer schoon - geen onbekende bids meer zichtbaar. Schakel LIVE weer in op het dashboard wanneer je klaar bent.`,

  sustained_paused_title: () => 'Bid aanhoudend Paused door Braiins',
  sustained_paused_title_recovery: () => 'Bid weer actief',
  sustained_paused_body: ({ duration, reason }) =>
    `Primaire bid is al ${duration} door Braiins op Paused gezet (last_pause_reason: ${reason}). Waarschijnlijk de Paused/Active-oscillatie - controleer de destination-pool / Datum gateway en overweeg een handmatige edit.`,
  sustained_paused_body_recovery: ({ duration }) =>
    `Primaire bid niet langer als Paused gemarkeerd - stond ${duration} op pauze. (Als de bid direct weer naar Paused springt is dat de gedocumenteerde Paused/Active-oscillatie - Braiins flipt de vlag terwijl hashrate gewoon door routeert.)`,

  beta_exit_title: () => 'Braiins beta-exit fees gedetecteerd',
  beta_exit_title_recovery: () => 'Braiins beta-exit fees opgeheven',
  beta_exit_body: ({ fee_pct }) =>
    `Braiins rekent nu een fee op minstens één actieve bid (fee_rate_pct: ${fee_pct}%). De marketplace lijkt uit beta te zijn - herevalueer het kostenmodel en de gedocumenteerde beta-exit-stappen.`,
  beta_exit_body_recovery: () =>
    `Actieve bids zijn weer terug op fee_rate_pct = 0. Of Braiins heeft het teruggedraaid, of alle fee-bearing bids zijn afgerekend.`,

  wallet_runway_title: ({ runway_days, threshold_days }) =>
    `Wallet runway ${runway_days} dagen (onder de ${threshold_days}-dagen drempel)`,
  wallet_runway_title_recovery: ({ runway_days, threshold_days }) =>
    `Wallet runway ${runway_days} dagen (boven de ${threshold_days}-dagen drempel)`,
  wallet_runway_body: ({ balance_sat, burn_per_day_sat, runway_days, threshold_days }) =>
    `Totaal Braiins-saldo (available + blocked) is ${balance_sat} sat; trailing-3h burn is ${burn_per_day_sat} sat/dag. Aan dat tempo is de wallet leeg in ${runway_days} dagen, onder de geconfigureerde ${threshold_days}-dagen drempel. Vul de Braiins-wallet bij of verlaag de bid; zonder bijvulling worden bids geannuleerd wegens onvoldoende saldo.`,
  wallet_runway_body_recovery: ({ runway_days, threshold_days }) =>
    `Wallet runway weer boven de drempel: ${runway_days} dagen (drempel ${threshold_days}). Waarschijnlijk is er bijgevuld of is de burn rate gedaald.`,

  pool_block_credited_title: ({ height, payout_btc }) =>
    payout_btc
      ? `Pool block bijgeschreven + ON-CHAIN UITBETALING - #${height}`
      : `Pool block bijgeschreven - #${height}`,
  pool_block_credited_body: ({ height, reward_btc, share_pct, credit, payout_sat, payout_btc, unpaid }) =>
    `Ocean vond pool block #${height} (reward ${reward_btc} BTC). Jouw aandeel: ${share_pct} → ${credit}.${payout_sat && payout_btc ? ` Uitbetaald: ${payout_sat} sat / ${payout_btc} BTC naar je payout-adres.` : ''} Unpaid totaal: ${unpaid}.`,

  braiins_deposit_detected_title: () => 'Braiins deposit gedetecteerd',
  braiins_deposit_detected_body: ({ amount, address_short }) =>
    `Braiins heeft een deposit van ${amount} gedetecteerd${address_short ? ` op ${address_short}...` : ''}. Funds worden doorgaans spendeerbaar na 3 confirmaties. In zeldzame gevallen wordt er een compliance screening getriggered, wat tot 48u extra kan duren voordat de funds spendeerbaar zijn.`,
  braiins_deposit_available_title: () => 'Braiins deposit beschikbaar',
  braiins_deposit_available_body: ({ amount }) =>
    `Braiins compliance heeft een deposit van ${amount} goedgekeurd - de funds zijn nu spendeerbaar op de Braiins marketplace.`,
  braiins_deposit_returned_title: () => 'Braiins deposit teruggestuurd',
  braiins_deposit_returned_body: ({ amount, return_tx_short }) =>
    `Braiins compliance heeft een deposit van ${amount} teruggestuurd. Return tx: ${return_tx_short}. Bekijk het Braiins dashboard voor de afwijsreden.`,

  solo_overheating_title: ({ label, temp_c, ceiling_c }) =>
    `Solo-miner oververhit: ${label} (${temp_c} °C ≥ ${ceiling_c} °C)`,
  solo_overheating_title_recovery: ({ label }) => `Solo-miner afgekoeld: ${label}`,
  solo_overheating_body: ({ label, temp_c, ceiling_c, duration }) =>
    `${label} zit al ${duration} op of boven ${ceiling_c} °C (nu ${temp_c} °C). Controleer luchtstroom en omgevingstemperatuur; de ASIC throttlet of valt uit als het verder oploopt.`,
  solo_overheating_body_recovery: ({ label, duration }) =>
    `${label} weer onder de thermische grens - was ${duration} oververhit.`,

  solo_zero_hashrate_title: ({ label }) => `Solo-miner offline: ${label}`,
  solo_zero_hashrate_title_recovery: ({ label }) => `Solo-miner online: ${label}`,
  solo_zero_hashrate_body: ({ label, reason, duration }) =>
    `${label} is al ${duration} ${reason}. Controleer voeding / WiFi / pool-config.`,
  solo_zero_hashrate_body_recovery: ({ label, duration }) =>
    `${label} rapporteert weer hashrate - was ${duration} offline.`,

  solo_share_rejection_title: ({ label }) =>
    `Solo-miner share-verwerping hoog: ${label}`,
  solo_share_rejection_body: ({ label, rate_pct, rejected, total, window_min }) =>
    `${label} heeft ${rejected} van ${total} shares (${rate_pct} %) afgewezen in de laatste ${window_min} min. Waarschijnlijk een stratum-/freq-/voltage-misconfiguratie.`,

  solo_stratum_drift_title: ({ label }) => `Solo-miner stratum gewijzigd: ${label}`,
  solo_stratum_drift_body: ({ label, old_url, new_url }) =>
    `Stratum-URL van ${label} is gewijzigd van ${old_url} naar ${new_url}. Als jij dit niet deed heeft iemand het apparaat omgezet.`,

  solo_best_difficulty_title: ({ difficulty }) =>
    `Nieuw beste difficulty: ${difficulty}`,
  solo_best_difficulty_body: ({ label, difficulty, previous, improvement }) =>
    `${label} heeft een share ingediend met difficulty ${difficulty}${improvement ? ` (${improvement}x verbetering)` : ''}. ${previous ? `Vorig record: ${previous}. ` : ''}`,
};

const ES: AlertCopy = {
  prefix_important: '🔴 [IMPORTANTE]',
  prefix_warning: '⚠️ [ADVERTENCIA]',
  prefix_info: 'ℹ️ [INFO]',
  prefix_resolved: '✅ [RESUELTO]',

  giving_up_body: 'Sigue mal después de 2h. Sin más notificaciones hasta que se resuelva.',

  datum_unreachable_title: () => 'Stratum de Datum no accesible',
  datum_unreachable_title_recovery: () => 'Stratum de Datum accesible',
  datum_unreachable_body: ({ duration }) =>
    `La gateway Datum lleva ${duration} sin ser accesible. La hashrate del comprador no puede llegar a Ocean - los shares no se acreditan. El autopilot ha cancelado la oferta activa para detener el gasto; reanudara las ofertas cuando el stratum se recupere.`,
  datum_unreachable_body_recovery: ({ duration }) =>
    `Gateway Datum accesible de nuevo - estuvo caída ${duration}.`,

  marketplace_empty_title: () => 'Mercado Braiins vacío',
  marketplace_empty_title_recovery: () => 'Hay oferta de nuevo en el mercado Braiins',
  marketplace_empty_body: ({ duration }) =>
    `El mercado Braiins lleva ${duration} sin hashrate disponible para tu objetivo. El autopilot está ofertando pero el libro de órdenes no tiene asks que puedan llenarlo. La entrega está a cero. Nada que hacer - se resuelve cuando vuelva la oferta.`,
  marketplace_empty_body_recovery: ({ duration }) =>
    `Volvió la oferta - estuvo vacío ${duration}. Las ofertas se están llenando otra vez.`,

  hashrate_below_floor_title: () => 'Hashrate por debajo del mínimo',
  hashrate_below_floor_title_recovery: () => 'Hashrate por encima del mínimo',
  hashrate_below_floor_body: ({ duration, actual_ph, floor_ph }) =>
    `La hashrate entregada lleva ${duration} por debajo del mínimo configurado. Actual: ${actual_ph} PH/s; mínimo: ${floor_ph} PH/s.`,
  hashrate_below_floor_body_recovery: ({ duration }) =>
    `Hashrate de nuevo en o por encima del mínimo - estuvo por debajo ${duration}.`,

  zero_hashrate_title: () => 'Hashrate cero',
  zero_hashrate_title_recovery: () => 'Hashrate fluyendo de nuevo',
  zero_hashrate_body: ({ duration }) =>
    `Sin hashrate entregada en ${duration}. Probablemente el marketplace dejó de enrutar - revisa la oferta activa y el estado de las comisiones.`,
  zero_hashrate_body_recovery: ({ duration }) =>
    `Hashrate fluyendo de nuevo - estuvo a cero ${duration}.`,

  api_unreachable_title: () => 'API de Braiins no accesible',
  api_unreachable_title_recovery: () => 'API de Braiins accesible',
  api_unreachable_body: ({ duration }) =>
    `La API del marketplace de Braiins lleva ${duration} sin ser accesible. El autopilot no puede leer orderbook / saldo / comisiones y no toma decisiones hasta que se restablezca.`,
  api_unreachable_body_recovery: ({ duration }) =>
    `API de Braiins accesible de nuevo - estuvo caída ${duration}.`,

  unknown_bid_title: () => 'Oferta desconocida detectada',
  unknown_bid_title_recovery: () => 'Cuenta limpia (sin ofertas desconocidas)',
  unknown_bid_body: ({ count, ids }) =>
    `${count} oferta(s) en la cuenta de Braiins que el autopilot no creó: ${ids}. Daemon auto-PAUSED por la regla de orden desconocida. Inspecciona en el dashboard de Braiins antes de volver a LIVE.`,
  unknown_bid_body_recovery: () =>
    `La cuenta está limpia de nuevo - no hay ofertas desconocidas visibles. Reactiva LIVE en el dashboard cuando quieras.`,

  sustained_paused_title: () => 'Oferta sostenidamente Paused por Braiins',
  sustained_paused_title_recovery: () => 'Oferta activa de nuevo',
  sustained_paused_body: ({ duration, reason }) =>
    `La oferta primaria lleva ${duration} en Paused por Braiins (last_pause_reason: ${reason}). Probablemente la oscilación Paused/Active - revisa la pool de destino / Datum gateway y considera un edit manual.`,
  sustained_paused_body_recovery: ({ duration }) =>
    `Oferta primaria ya no marcada como Paused - estuvo en pausa ${duration}. (Si vuelve a Paused inmediatamente es la oscilación Paused/Active documentada - Braiins toggla la marca mientras la hashrate sigue enrutando.)`,

  beta_exit_title: () => 'Comisiones de salida de beta de Braiins detectadas',
  beta_exit_title_recovery: () => 'Comisiones de salida de beta de Braiins eliminadas',
  beta_exit_body: ({ fee_pct }) =>
    `Braiins está cobrando una comisión no nula en al menos una oferta activa (fee_rate_pct: ${fee_pct}%). El marketplace parece haber salido de beta - reevalúa el modelo de costes y considera los pasos documentados.`,
  beta_exit_body_recovery: () =>
    `Las ofertas activas vuelven a fee_rate_pct = 0. O bien Braiins lo revirtió, o todas las ofertas con comisión se liquidaron.`,

  wallet_runway_title: ({ runway_days, threshold_days }) =>
    `Autonomía de wallet ${runway_days} días (por debajo del umbral de ${threshold_days} días)`,
  wallet_runway_title_recovery: ({ runway_days, threshold_days }) =>
    `Autonomía de wallet ${runway_days} días (por encima del umbral de ${threshold_days} días)`,
  wallet_runway_body: ({ balance_sat, burn_per_day_sat, runway_days, threshold_days }) =>
    `Saldo total de Braiins (available + blocked) es ${balance_sat} sat; consumo trailing-3h es ${burn_per_day_sat} sat/día. A ese ritmo la wallet llega a cero en ${runway_days} días, por debajo del umbral configurado de ${threshold_days} días. Recarga la wallet de Braiins o baja la oferta; sin recarga, las ofertas empezarán a cancelarse por fondos insuficientes.`,
  wallet_runway_body_recovery: ({ runway_days, threshold_days }) =>
    `Autonomía de wallet de nuevo por encima del umbral: ${runway_days} días (umbral ${threshold_days}). Probablemente entró una recarga o bajó el consumo.`,

  pool_block_credited_title: ({ height, payout_btc }) =>
    payout_btc
      ? `Bloque de pool acreditado + PAGO ON-CHAIN - #${height}`
      : `Bloque de pool acreditado - #${height}`,
  pool_block_credited_body: ({ height, reward_btc, share_pct, credit, payout_sat, payout_btc, unpaid }) =>
    `Ocean encontró el bloque de pool #${height} (recompensa ${reward_btc} BTC). Tu parte: ${share_pct} → ${credit}.${payout_sat && payout_btc ? ` Pagado: ${payout_sat} sat / ${payout_btc} BTC a tu dirección de pago.` : ''} Total no pagado: ${unpaid}.`,

  braiins_deposit_detected_title: () => 'Depósito en Braiins detectado',
  braiins_deposit_detected_body: ({ amount, address_short }) =>
    `Braiins ha detectado un depósito de ${amount}${address_short ? ` a ${address_short}...` : ''}. Los fondos suelen ser gastables tras 3 confirmaciones. En casos raros se activa una verificación de cumplimiento, que puede añadir hasta 48h antes de que sean gastables.`,
  braiins_deposit_available_title: () => 'Depósito en Braiins disponible',
  braiins_deposit_available_body: ({ amount }) =>
    `El cumplimiento de Braiins aprobó un depósito de ${amount} - los fondos ya son gastables en el marketplace de Braiins.`,
  braiins_deposit_returned_title: () => 'Depósito en Braiins devuelto',
  braiins_deposit_returned_body: ({ amount, return_tx_short }) =>
    `El cumplimiento de Braiins ha devuelto un depósito de ${amount}. Tx de devolución: ${return_tx_short}. Revisa el dashboard de Braiins para el motivo del rechazo.`,

  solo_overheating_title: ({ label, temp_c, ceiling_c }) =>
    `Minero solo sobrecalentado: ${label} (${temp_c} °C ≥ ${ceiling_c} °C)`,
  solo_overheating_title_recovery: ({ label }) => `Minero solo enfriado: ${label}`,
  solo_overheating_body: ({ label, temp_c, ceiling_c, duration }) =>
    `${label} lleva ${duration} en o por encima de ${ceiling_c} °C (actual ${temp_c} °C). Revisa flujo de aire y temperatura ambiente; el ASIC bajará rendimiento o se apagará si sigue subiendo.`,
  solo_overheating_body_recovery: ({ label, duration }) =>
    `${label} de nuevo por debajo del límite térmico - estuvo sobrecalentado ${duration}.`,

  solo_zero_hashrate_title: ({ label }) => `Minero solo offline: ${label}`,
  solo_zero_hashrate_title_recovery: ({ label }) => `Minero solo en línea: ${label}`,
  solo_zero_hashrate_body: ({ label, reason, duration }) =>
    `${label} lleva ${duration} ${reason}. Revisa alimentación / WiFi / configuración de pool.`,
  solo_zero_hashrate_body_recovery: ({ label, duration }) =>
    `${label} vuelve a reportar hashrate - estuvo offline ${duration}.`,

  solo_share_rejection_title: ({ label }) =>
    `Tasa de rechazo de shares alta: ${label}`,
  solo_share_rejection_body: ({ label, rate_pct, rejected, total, window_min }) =>
    `${label} rechazó ${rejected} de ${total} shares (${rate_pct} %) en los últimos ${window_min} min. Probable mala configuración de stratum / frecuencia / voltaje.`,

  solo_stratum_drift_title: ({ label }) => `Stratum del minero solo cambió: ${label}`,
  solo_stratum_drift_body: ({ label, old_url, new_url }) =>
    `La URL stratum de ${label} cambió de ${old_url} a ${new_url}. Si no fuiste tú, alguien reapuntó el dispositivo.`,

  solo_best_difficulty_title: ({ difficulty }) =>
    `Nuevo mejor difficulty: ${difficulty}`,
  solo_best_difficulty_body: ({ label, difficulty, previous, improvement }) =>
    `${label} envió un share con difficulty ${difficulty}${improvement ? ` (${improvement}x mejora)` : ''}. ${previous ? `Récord anterior: ${previous}. ` : ''}`,
};

const CATALOGS: Record<AlertLocale, AlertCopy> = { en: EN, nl: NL, es: ES };

export function getAlertCopy(locale: string | null | undefined): AlertCopy {
  if (isAlertLocale(locale)) return CATALOGS[locale];
  return EN;
}
