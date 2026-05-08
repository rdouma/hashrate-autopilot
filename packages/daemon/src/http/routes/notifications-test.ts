/**
 * POST /api/notifications/test (#100)
 *
 * Test Telegram delivery using bot_token + chat_id from the request
 * body. Mirrors /api/bitcoind/test - operator clicks "Test connection"
 * on the Config page with typed-but-unsaved values; the route spins
 * up a TelegramSink against those exact values and reports the result
 * inline. Deliberately does NOT fall back to saved config: the whole
 * point of clicking Test is to validate UNSAVED candidate values.
 */

import type { FastifyInstance } from 'fastify';

import { TelegramSink } from '../../services/notifier.js';

export interface NotificationsTestRequest {
  bot_token?: string;
  chat_id?: string;
}

export interface NotificationsTestResponse {
  ok: boolean;
  error?: string | null;
}

export async function registerNotificationsTestRoute(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Body?: NotificationsTestRequest }>(
    '/api/notifications/test',
    async (req): Promise<NotificationsTestResponse> => {
      const body = req.body ?? {};
      const bot_token = body.bot_token?.trim() ?? '';
      const chat_id = body.chat_id?.trim() ?? '';

      if (!bot_token || !chat_id) {
        return { ok: false, error: 'bot token and chat id are both required' };
      }

      const sink = new TelegramSink({ bot_token, chat_id });
      const result = await sink.verify();
      return { ok: result.ok, error: result.error };
    },
  );
}
