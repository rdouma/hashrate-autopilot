import fastifyBasicAuth from '@fastify/basic-auth';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isApiRequest, requiresDashboardAuth } from './server.js';

/**
 * GHSA-35jm-xg76-3hh4: the auth decision must follow the route the
 * router matched, not the raw request target. These tests drive the
 * exported predicates through a real Fastify router, wired the same way
 * createHttpServer wires them.
 */
describe('dashboard auth follows the matched route (GHSA-35jm-xg76-3hh4)', () => {
  let app: FastifyInstance;
  const AUTH = `Basic ${Buffer.from('u:right').toString('base64')}`;

  beforeEach(async () => {
    app = Fastify();
    await app.register(fastifyBasicAuth, {
      validate: async (_u, p) => {
        if (p !== 'right') throw new Error('unauthorised');
      },
    });
    app.addHook('onRequest', (req, reply, done) => {
      if (!requiresDashboardAuth(req)) return done();
      app.basicAuth(req, reply, done);
    });
    app.get('/api/health', async () => ({ status: 'ok' }));
    app.get('/api/config', async () => ({ secret: 'config' }));
    app.post('/api/run-mode', async () => ({ ok: true }));
    app.get('/*', async () => 'static');
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ['GET', '/api/config'],
    ['GET', '/%61pi/config'],
    ['GET', '/ap%69/config'],
    ['GET', '/api/%63onfig'],
    ['GET', '/%61%70%69/config'],
    ['GET', '/api/config?x=1'],
    ['POST', '/%61pi/run-mode'],
  ] as const)('%s %s without a password is refused', async (method, url) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });

  it('the encoded form still works with the right password', async () => {
    const res = await app.inject({ method: 'GET', url: '/%61pi/config', headers: { authorization: AUTH } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ secret: 'config' });
  });

  it('/api/health stays public, encoded or not', async () => {
    for (const url of ['/api/health', '/%61pi/health', '/api/health?probe=1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    }
  });

  it('an unmatched /api path asks for auth instead of passing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(401);
  });

  it('non-API static paths stay public', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index.js' });
    expect(res.statusCode).toBe(200);
  });

  it('isApiRequest sees through an encoded prefix (rate limiter)', () => {
    expect(isApiRequest({ url: '/%61pi/config', routeOptions: { url: '/api/config' } })).toBe(true);
    expect(isApiRequest({ url: '/api/nope', routeOptions: {} })).toBe(true);
    expect(isApiRequest({ url: '/assets/x.js', routeOptions: { url: '/*' } })).toBe(false);
  });
});
