/**
 * POST /api/notifications/test-event
 *
 * Sends a sample message for the given event_class to Telegram using
 * the saved bot_token + chat_id (intentionally NOT the in-form values
 * - this is a "show me how a real <event> would look" affordance,
 * not a credential validator). Returns ok:false with a clear error
 * when no bot is configured yet, so the dashboard can show a
 * meaningful failure message.
 *
 * The sample uses the live State snapshot where the underlying value
 * is plausible (e.g. wallet_runway uses the current balance + burn
 * rate). When the live state doesn't fit (e.g. the daemon has not
 * recorded a pool-block yet), the route falls back to plausible
 * synthetic data with a "[SAMPLE]" hedge so the operator doesn't
 * mistake the figures for real telemetry. Every test message is
 * marked "[TEST]" in the title prefix to disambiguate from a real
 * fired alert in the operator's chat history.
 */

import type { FastifyInstance } from 'fastify';

import { formatTelegramBody } from '../../services/alert-manager.js';
import { TelegramSink } from '../../services/notifier.js';
import { getAlertCopy } from '../../i18n/alert-copy.js';
import {
  formatBtc,
  formatFixed,
  formatInteger,
  formatPct,
  formatSat,
  resolveDisplayLocale,
  type ResolvedDisplayLocale,
} from '../../i18n/format-numbers.js';
import type { ConfigRepo } from '../../state/repos/config.js';
import type { AlertSeverity } from '../../state/types.js';

export interface TestEventRequest {
  event_class?: string;
}

export interface TestEventResponse {
  ok: boolean;
  error?: string | null;
}

interface Sample {
  severity: AlertSeverity;
  title: string;
  body: string;
  /** When true, render as a [RESOLVED] message regardless of severity. */
  is_recovery: boolean;
}

/**
 * #131 follow-up: each sample is now a function of the operator's
 * configured `notification_locale`. The body strings come straight
 * from the same catalog (`getAlertCopy`) the live alert path uses,
 * fed with synthetic-but-plausible args, so the operator's preview
 * matches the language they'll see when the real alert fires. No
 * separate "[SAMPLE]" copy hedge - the [TEST] title prefix added
 * below already disambiguates from a real fired alert in chat
 * history.
 *
 * #227 follow-up #2: builders also take `display_number_locale`
 * (resolved) so synthetic numbers route through the same
 * formatInteger / formatBtc / formatSat / formatPct helpers the live
 * alert path uses. Previously the synthetic values were hardcoded
 * English literals (`'948,512'`, `'1,062,144'`, `'~40,635 sat'`),
 * which meant an operator with Display & Logging set to 1.234,56
 * still saw comma-thousand previews - making "test notification"
 * useless as a check that the locale plumbing was working. With this
 * change the preview matches the real-alert formatting exactly.
 */
function buildDepositDetected(
  locale: string | null | undefined,
  fmt: ResolvedDisplayLocale,
): Sample {
  const c = getAlertCopy(locale);
  return {
    severity: 'INFO',
    title: c.braiins_deposit_detected_title(),
    body: c.braiins_deposit_detected_body({
      amount: `${formatBtc(1_000_000, fmt)} BTC (${formatInteger(1_000_000, fmt)} sat)`,
      address_short: null,
    }),
    is_recovery: false,
  };
}

/** Exported for testing: each entry takes (language, numberLocale)
 *  and returns the synthetic Sample shipped to Telegram on /api/notifications/test-event.
 *  Synthetic values must route through formatInteger / formatBtc /
 *  formatSat / formatFixed / formatPct so the preview matches the
 *  live alert path's locale handling exactly. */
export const SAMPLE_BUILDERS: Record<
  string,
  (locale: string | null | undefined, fmt: ResolvedDisplayLocale) => Sample
> = {
  datum_unreachable: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.datum_unreachable_title(),
      body: c.datum_unreachable_body({ duration: '12m' }),
      is_recovery: false,
    };
  },
  marketplace_empty: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'INFO',
      title: c.marketplace_empty_title(),
      body: c.marketplace_empty_body({ duration: '8m' }),
      is_recovery: false,
    };
  },
  hashrate_below_floor: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.hashrate_below_floor_title(),
      body: c.hashrate_below_floor_body({
        duration: '11m',
        actual_ph: formatFixed(0.5, 2, fmt),
        floor_ph: formatFixed(1.0, 2, fmt),
      }),
      is_recovery: false,
    };
  },
  zero_hashrate: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.zero_hashrate_title(),
      body: c.zero_hashrate_body({ duration: '16m' }),
      is_recovery: false,
    };
  },
  api_unreachable: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.api_unreachable_title(),
      body: c.api_unreachable_body({ duration: '12m' }),
      is_recovery: false,
    };
  },
  unknown_bid: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.unknown_bid_title(),
      body: c.unknown_bid_body({ count: 1, ids: 'B99999' }),
      is_recovery: false,
    };
  },
  sustained_paused: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.sustained_paused_title(),
      body: c.sustained_paused_body({
        duration: '11m',
        reason: 'not possible to deliver the hashing power at this time',
      }),
      is_recovery: false,
    };
  },
  beta_exit: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'WARNING',
      title: c.beta_exit_title(),
      body: c.beta_exit_body({ fee_pct: formatFixed(1.5, 1, fmt) }),
      is_recovery: false,
    };
  },
  wallet_runway: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.wallet_runway_title({
        runway_days: formatFixed(1.5, 1, fmt),
        threshold_days: formatFixed(3.0, 1, fmt),
      }),
      body: c.wallet_runway_body({
        balance_sat: formatInteger(210_000, fmt),
        burn_per_day_sat: formatInteger(140_000, fmt),
        runway_days: formatFixed(1.5, 1, fmt),
        threshold_days: 3,
      }),
      is_recovery: false,
    };
  },
  // #141: lifecycle restored. The dashboard's single tile keyed
  // `braiins_deposit` test-button previews the Detected message;
  // each of the three per-class canonical event_class names is also
  // accepted so an operator can probe any leg via the API directly.
  braiins_deposit: (locale, fmt) => buildDepositDetected(locale, fmt),
  braiins_deposit_detected: (locale, fmt) => buildDepositDetected(locale, fmt),
  braiins_deposit_available: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'INFO',
      title: c.braiins_deposit_available_title(),
      body: c.braiins_deposit_available_body({
        amount: `${formatBtc(1_000_000, fmt)} BTC (${formatInteger(1_000_000, fmt)} sat)`,
      }),
      is_recovery: false,
    };
  },
  braiins_deposit_returned: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.braiins_deposit_returned_title(),
      body: c.braiins_deposit_returned_body({
        amount: `${formatBtc(1_000_000, fmt)} BTC (${formatInteger(1_000_000, fmt)} sat)`,
        return_tx_short: 'a1b2c3d4...e5f6g7h8',
      }),
      is_recovery: false,
    };
  },
  pool_block_credited: (locale, fmt) => {
    const c = getAlertCopy(locale);
    const height = formatInteger(948_512, fmt);
    return {
      severity: 'INFO',
      title: c.pool_block_credited_title({ height, payout_btc: null }),
      body: c.pool_block_credited_body({
        height,
        reward_btc: formatBtc(312_575_382, fmt),
        share_pct: formatPct(0.013, 4, fmt),
        credit: `~${formatSat(40_635, fmt)}`,
        payout_sat: null,
        payout_btc: null,
        unpaid: `${formatSat(250_000, fmt)} (${formatPct(23.8, 1, fmt)} of ${formatInteger(1_048_576, fmt)}-sat payout)`,
      }),
      is_recovery: false,
    };
  },
  // #226: Ocean payout lifecycle previews. Plausible synthetic
  // values reflecting a real payout near the 1,048,576-sat threshold.
  payout_initiated: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'INFO',
      title: c.payout_initiated_title({ payout_btc: formatBtc(1_062_144, fmt) }),
      body: c.payout_initiated_body({
        payout_sat: formatInteger(1_062_144, fmt),
        payout_btc: formatBtc(1_062_144, fmt),
        pre_drop_unpaid: formatSat(1_074_562, fmt),
        residual_unpaid: formatSat(12_418, fmt),
      }),
      is_recovery: false,
    };
  },
  payout_confirmed: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'INFO',
      title: c.payout_confirmed_title({ payout_btc: formatBtc(1_062_144, fmt) }),
      body: c.payout_confirmed_body({
        payout_sat: formatInteger(1_062_144, fmt),
        payout_btc: formatBtc(1_062_144, fmt),
        height: formatInteger(951_602, fmt),
      }),
      is_recovery: false,
    };
  },
  // #149: solo-mining event classes. Each preview uses a plausible
  // synthetic device label + readings so the operator can see
  // exactly what a real alert will look like in chat history.
  solo_overheating: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.solo_overheating_title({
        label: 'Bedroom Gamma',
        temp_c: formatFixed(72.5, 1, fmt),
        ceiling_c: formatInteger(68, fmt),
      }),
      body: c.solo_overheating_body({
        label: 'Bedroom Gamma',
        temp_c: formatFixed(72.5, 1, fmt),
        ceiling_c: formatInteger(68, fmt),
        duration: '2m',
      }),
      is_recovery: false,
    };
  },
  solo_zero_hashrate: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.solo_zero_hashrate_title({ label: 'Bedroom Gamma' }),
      body: c.solo_zero_hashrate_body({
        label: 'Bedroom Gamma',
        reason: 'unreachable',
        duration: '6m',
      }),
      is_recovery: false,
    };
  },
  solo_share_rejection: (locale, fmt) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.solo_share_rejection_title({ label: 'Bedroom Gamma' }),
      body: c.solo_share_rejection_body({
        label: 'Bedroom Gamma',
        rate_pct: formatFixed(12.4, 2, fmt),
        rejected: formatInteger(124, fmt),
        total: formatInteger(1_000, fmt),
        window_min: '60',
      }),
      is_recovery: false,
    };
  },
  solo_stratum_drift: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.solo_stratum_drift_title({ label: 'Bedroom Gamma' }),
      body: c.solo_stratum_drift_body({
        label: 'Bedroom Gamma',
        old_url: 'stratum+tcp://pool.example:3333',
        new_url: 'stratum+tcp://other-pool.example:3334',
      }),
      is_recovery: false,
    };
  },
};

export interface TestEventDeps {
  readonly configRepo: ConfigRepo;
}

export async function registerNotificationsTestEventRoute(
  app: FastifyInstance,
  deps: TestEventDeps,
): Promise<void> {
  app.post<{ Body?: TestEventRequest }>(
    '/api/notifications/test-event',
    async (req): Promise<TestEventResponse> => {
      const eventClass = (req.body?.event_class ?? '').trim();
      if (!Object.hasOwn(SAMPLE_BUILDERS, eventClass)) {
        return { ok: false, error: `unknown event_class: ${eventClass || '(empty)'}` };
      }
      const builder = SAMPLE_BUILDERS[eventClass]!;

      const cfg = await deps.configRepo.get();
      if (!cfg) {
        return { ok: false, error: 'configuration not initialised' };
      }
      const bot_token = cfg.telegram_bot_token?.trim() ?? '';
      const chat_id = cfg.telegram_chat_id?.trim() ?? '';
      if (!bot_token || !chat_id) {
        return {
          ok: false,
          error:
            'Telegram bot token and chat id must be saved on Config → Notifications before a test message can be sent.',
        };
      }

      const locale = cfg.notification_locale ?? 'en';
      // #227 follow-up #2: synthetic numbers in the test preview
      // honor Display & Logging → Number format, same path the live
      // alert evaluator uses (numberLocale(state) on alert-evaluator.ts).
      // Without this, an operator with 1.234,56 still saw 948,512 in
      // the preview and concluded the locale wiring was broken.
      const fmt = resolveDisplayLocale(cfg.display_number_locale);
      const sample = builder(locale, fmt);
      const sink = new TelegramSink({
        bot_token,
        chat_id,
        instance_label: cfg.telegram_instance_label?.trim() ?? '',
      });
      // Prefix the title with [TEST] so the operator's chat history
      // shows the difference between a real fired alert and a
      // dashboard-triggered preview at a glance, even after months.
      const body = formatTelegramBody(
        sample.severity,
        `[TEST] ${sample.title}`,
        sample.body,
        sample.is_recovery,
        locale,
      );
      const result = await sink.send(body, {});
      return { ok: result.ok, error: result.error };
    },
  );
}
