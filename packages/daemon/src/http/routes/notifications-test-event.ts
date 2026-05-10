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
 */
const SAMPLE_BUILDERS: Record<string, (locale: string | null | undefined) => Sample> = {
  datum_unreachable: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.datum_unreachable_title(),
      body: c.datum_unreachable_body({ duration: '12m' }),
      is_recovery: false,
    };
  },
  hashrate_below_floor: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.hashrate_below_floor_title(),
      body: c.hashrate_below_floor_body({
        duration: '11m',
        actual_ph: '0.50',
        floor_ph: '1.00',
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
  beta_exit: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'WARNING',
      title: c.beta_exit_title(),
      body: c.beta_exit_body({ fee_pct: '1.5' }),
      is_recovery: false,
    };
  },
  wallet_runway: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.wallet_runway_title({ runway_days: '1.5', threshold_days: '3.0' }),
      body: c.wallet_runway_body({
        balance_sat: '210,000',
        burn_per_day_sat: '140,000',
        runway_days: '1.5',
        threshold_days: 3,
      }),
      is_recovery: false,
    };
  },
  // #141: lifecycle restored. The dashboard's single tile keyed
  // `braiins_deposit` test-button still previews the Detected
  // message; the per-class _available / _returned keys are exposed
  // here so an operator can probe each leg via the API directly.
  braiins_deposit: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'INFO',
      title: c.braiins_deposit_detected_title(),
      body: c.braiins_deposit_detected_body({
        amount: '0.01000000 BTC (1,000,000 sat)',
        address_short: null,
      }),
      is_recovery: false,
    };
  },
  braiins_deposit_available: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'INFO',
      title: c.braiins_deposit_available_title(),
      body: c.braiins_deposit_available_body({
        amount: '0.01000000 BTC (1,000,000 sat)',
      }),
      is_recovery: false,
    };
  },
  braiins_deposit_returned: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'IMPORTANT',
      title: c.braiins_deposit_returned_title(),
      body: c.braiins_deposit_returned_body({
        amount: '0.01000000 BTC (1,000,000 sat)',
        return_tx_short: 'a1b2c3d4...e5f6g7h8',
      }),
      is_recovery: false,
    };
  },
  pool_block_credited: (locale) => {
    const c = getAlertCopy(locale);
    return {
      severity: 'INFO',
      title: c.pool_block_credited_title({ height: '948,512' }),
      body: c.pool_block_credited_body({
        height: '948,512',
        reward_btc: '3.12575382',
        share_pct: '0.0130%',
        credit: '~40,635 sat',
        unpaid: '250,000 sat (23.8% of 1,048,576-sat payout)',
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
      const builder = SAMPLE_BUILDERS[eventClass];
      if (!builder) {
        return { ok: false, error: `unknown event_class: ${eventClass || '(empty)'}` };
      }

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
      const sample = builder(locale);
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
