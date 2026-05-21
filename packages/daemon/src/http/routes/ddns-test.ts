/**
 * POST /api/ddns/test
 *
 * Validates DDNS credentials by performing a real update against the
 * configured provider with the values currently in the form. Same
 * shape as the other test routes: take unsaved values, run the call,
 * report success or the provider's error string back to the operator.
 *
 * For No-IP we use the dyndns2 protocol on dynupdate.no-ip.com.
 * Happy responses: `good <ip>` (IP changed), `nochg <ip>` (already
 * matched - still a success). Anything else is an error per
 * provider's spec (`badauth`, `nohost`, `abuse`, etc.).
 */

import type { FastifyInstance } from 'fastify';

import type { DdnsUpdaterService } from '../../services/ddns-updater.js';
import type { PublicIpService } from '../../services/public-ip.js';
import { USER_AGENT } from './build.js';

const NOIP_UPDATE_URL = 'https://dynupdate.no-ip.com/nic/update';

export interface DdnsTestRouteDeps {
  readonly ddnsUpdater: DdnsUpdaterService;
  readonly publicIpService: PublicIpService;
}

export interface DdnsTestRequest {
  provider?: string;
  hostname?: string;
  username?: string;
  credential?: string;
  /** dyndns2 only: provider-specific update URL. */
  update_url?: string;
}

export interface DdnsTestResponse {
  ok: boolean;
  status?: string;
  ip?: string;
  raw?: string;
  error?: string;
}

export async function registerDdnsTestRoute(
  app: FastifyInstance,
  deps: DdnsTestRouteDeps,
): Promise<void> {
  app.post<{ Body?: DdnsTestRequest }>(
    '/api/ddns/test',
    async (req): Promise<DdnsTestResponse> => {
      const body = req.body ?? {};
      const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
      const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : '';
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const credential = typeof body.credential === 'string' ? body.credential : '';
      const updateUrl = typeof body.update_url === 'string' ? body.update_url.trim() : '';

      if (!provider) return { ok: false, error: 'provider is required' };
      if (!hostname) return { ok: false, error: 'hostname is required' };
      if (!credential) return { ok: false, error: 'credential is required' };
      // username is required for dyndns2-style providers (No-IP, dyndns2);
      // DuckDNS uses a token-only flow, no username.
      if ((provider === 'noip' || provider === 'dyndns2') && !username) {
        return { ok: false, error: 'username is required' };
      }
      if (provider === 'dyndns2' && !updateUrl) {
        return { ok: false, error: 'update URL is required for dyndns2' };
      }
      if (provider === 'dyndns2') {
        try {
          const parsed = new URL(updateUrl);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return { ok: false, error: 'update URL must use http or https' };
          }
        } catch {
          return { ok: false, error: 'update URL is not a valid URL' };
        }
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8_000);
      try {
        if (provider === 'noip') {
          const url = `${NOIP_UPDATE_URL}?hostname=${encodeURIComponent(hostname)}`;
          const auth = Buffer.from(`${username}:${credential}`).toString('base64');
          const resp = await fetch(url, {
            headers: {
              Authorization: `Basic ${auth}`,
              'User-Agent': USER_AGENT,
            },
            signal: ac.signal,
          });
          const raw = (await resp.text()).trim();
          const parts = raw.split(/\s+/);
          const status = parts[0] ?? '';
          const ip = parts[1] ?? '';
          const happy = status === 'good' || status === 'nochg';
          if (happy) {
            const recordedIp = ip || deps.publicIpService.getSnapshot().ip || '';
            if (recordedIp) {
              deps.ddnsUpdater.recordExternalPush({
                provider: 'noip',
                hostname,
                ip: recordedIp,
                status,
                now: Date.now(),
              });
            }
            return { ok: true, status, ip, raw };
          }
          return { ok: false, status, raw, error: raw || `HTTP ${resp.status}` };
        }
        if (provider === 'dyndns2') {
          const sep = updateUrl.includes('?') ? '&' : '?';
          const url = `${updateUrl}${sep}hostname=${encodeURIComponent(hostname)}`;
          const auth = Buffer.from(`${username}:${credential}`).toString('base64');
          const resp = await fetch(url, {
            headers: {
              Authorization: `Basic ${auth}`,
              'User-Agent': USER_AGENT,
            },
            signal: ac.signal,
          });
          const raw = (await resp.text()).trim();
          const parts = raw.split(/\s+/);
          const status = parts[0] ?? '';
          const ip = parts[1] ?? '';
          const happy = status === 'good' || status === 'nochg';
          if (happy) {
            const recordedIp = ip || deps.publicIpService.getSnapshot().ip || '';
            if (recordedIp) {
              deps.ddnsUpdater.recordExternalPush({
                provider: 'dyndns2',
                hostname,
                ip: recordedIp,
                status,
                now: Date.now(),
              });
            }
            return { ok: true, status, ip, raw };
          }
          return { ok: false, status, raw, error: raw || `HTTP ${resp.status}` };
        }
        if (provider === 'duckdns') {
          // DuckDNS expects bare subdomain, no `ip=` (their server uses the source IP).
          const sub = hostname.replace(/\.duckdns\.org$/i, '');
          const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(credential)}`;
          const resp = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: ac.signal,
          });
          const raw = (await resp.text()).trim();
          const happy = raw === 'OK';
          if (happy) {
            const recordedIp = deps.publicIpService.getSnapshot().ip || '';
            if (recordedIp) {
              deps.ddnsUpdater.recordExternalPush({
                provider: 'duckdns',
                hostname,
                ip: recordedIp,
                status: 'good',
                now: Date.now(),
              });
            }
            return { ok: true, status: 'good', raw };
          }
          return { ok: false, status: raw || 'KO', raw, error: raw || `HTTP ${resp.status}` };
        }
        return { ok: false, error: `provider '${provider}' is not supported` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  );
}
