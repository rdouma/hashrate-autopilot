import { describe, expect, it } from 'vitest';
import { BraiinsApiError, readGrpcMessage } from './errors.js';

describe('readGrpcMessage', () => {
  it('returns undefined when the header is absent', () => {
    const h = new Headers();
    expect(readGrpcMessage(h)).toBeUndefined();
  });

  it('percent-decodes UTF-8 content', () => {
    const h = new Headers({ 'grpc-message': 'price%20must%20be%20higher%20than%20floor' });
    expect(readGrpcMessage(h)).toBe('price must be higher than floor');
  });

  it('round-trips an encodeURIComponent payload', () => {
    const original = 'minimum speed not met: 1.00 PH/s < 2.00 PH/s';
    const h = new Headers({ 'grpc-message': encodeURIComponent(original) });
    expect(readGrpcMessage(h)).toBe(original);
  });

  it('falls back to the raw string on malformed encoding', () => {
    const h = new Headers({ 'grpc-message': '%E0%A4%A' });
    expect(readGrpcMessage(h)).toBe('%E0%A4%A');
  });

  it('is case-insensitive on the header name', () => {
    const h = new Headers({ 'Grpc-Message': 'hello' });
    expect(readGrpcMessage(h)).toBe('hello');
  });
});

describe('BraiinsApiError', () => {
  it('embeds the grpc-message in the default message', () => {
    const err = new BraiinsApiError({
      status: 429,
      endpoint: '/spot/bid',
      grpcMessage: 'rate limited',
    });
    expect(err.message).toContain('429');
    expect(err.message).toContain('rate limited');
    expect(err.status).toBe(429);
    expect(err.endpoint).toBe('/spot/bid');
  });

  it('omits the grpc dash when the message is absent', () => {
    const err = new BraiinsApiError({ status: 500, endpoint: '/spot/stats' });
    expect(err.message).toBe('Braiins API /spot/stats returned 500');
  });
});
