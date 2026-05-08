import { describe, expect, it, vi } from 'vitest';

import { TelegramSink } from './notifier.js';

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('TelegramSink', () => {
  it('returns ok=true with delivery_meta_json on a 200', async () => {
    const sink = new TelegramSink({
      bot_token: 'tok',
      chat_id: '42',
      fetchImpl: makeFetch(200, { ok: true, result: { message_id: 7 } }),
    });
    const res = await sink.send('hello');
    expect(res.ok).toBe(true);
    expect(res.delivery_meta_json).toBe(JSON.stringify({ message_id: 7 }));
    expect(res.error).toBeNull();
  });

  it('returns ok=false with the API description when Telegram rejects', async () => {
    const sink = new TelegramSink({
      bot_token: 'tok',
      chat_id: '42',
      fetchImpl: makeFetch(403, {
        ok: false,
        description: 'bot was blocked by the user',
      }),
    });
    const res = await sink.send('hello');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('bot was blocked');
  });

  it('returns ok=false with a clear error when token + chat id are blank', async () => {
    const sink = new TelegramSink({ bot_token: '', chat_id: '' });
    const res = await sink.send('hello');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/required/i);
  });

  it('verify() POSTs a hello-world style probe', async () => {
    const fetchSpy = makeFetch(200, { ok: true, result: { message_id: 1 } });
    const sink = new TelegramSink({
      bot_token: 'tok',
      chat_id: '42',
      fetchImpl: fetchSpy,
    });
    const res = await sink.verify();
    expect(res.ok).toBe(true);
    const body = JSON.parse(
      (fetchSpy as unknown as { mock: { calls: Array<[string, RequestInit]> } })
        .mock.calls[0]![1].body as string,
    );
    expect(body.text).toMatch(/test message/i);
    expect(body.chat_id).toBe('42');
  });

  it('surfaces a fetch-time exception as an error string with the URL', async () => {
    const sink = new TelegramSink({
      bot_token: 'tok',
      chat_id: '42',
      fetchImpl: vi.fn(async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    });
    const res = await sink.send('hi');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
    expect(res.error).toContain('api.telegram.org');
  });
});
