/**
 * #149 follow-up: local-network scanner for the "Scan local network"
 * button on Config -> Solo miners. Mirrors what the AxeOS Swarm tab
 * does client-side: walk a /24, probe each IP for `/api/system/info`
 * with a short timeout, and collect every host that responds with a
 * parseable JSON body (so non-Bitaxe hosts on the same subnet -
 * routers, NAS, printers - get filtered out by the failed JSON parse
 * rather than polluting the suggestion list).
 *
 * Subnet selection (#156):
 * - If the caller passes a CIDR, scanner uses it directly. Needed on
 *   Umbrel where the daemon container sees `10.21.0.0/24` (docker
 *   bridge) and never the host LAN where the Bitaxes live - the
 *   operator types e.g. `192.168.1.0/24` explicitly.
 * - Otherwise scanner deduces the /24 from the daemon's first
 *   non-loopback IPv4 interface via `os.networkInterfaces()`. Works
 *   on bare-metal where daemon shares the LAN with the miners.
 */

import { networkInterfaces } from 'node:os';

import type { SoloMinersRepo } from '../state/repos/solo_miners.js';
import { AxeOSClient } from './axeos.js';

export interface ScanCandidate {
  /** IP that answered /api/system/info. */
  readonly ip: string;
  /** ASIC model reported by AxeOS (e.g. "BM1370"). null when the firmware doesn't expose it. */
  readonly asic_model: string | null;
  /** Firmware version string. */
  readonly version: string | null;
  /** Live hashrate (GH/s) at scan time - lets the operator pick the live one if duplicates appear. */
  readonly hashrate_ghs: number | null;
  /** True when an existing solo_miners row already owns this IP. */
  readonly already_added: boolean;
}

export interface ScanResult {
  /** The CIDR that was actually scanned, e.g. "192.168.1.0/24". */
  readonly cidr: string;
  /** Discovered AxeOS hosts. */
  readonly candidates: ReadonlyArray<ScanCandidate>;
  /** Empty -> daemon couldn't infer a local /24 (e.g. no non-loopback IPv4 interface). */
  readonly error: string | null;
}

export interface AxeOSScannerOptions {
  readonly repo: SoloMinersRepo;
  readonly client?: AxeOSClient;
  readonly interfaces?: typeof networkInterfaces;
  /** Per-IP timeout for the scan probe. Default 200ms - keeps the whole /24 around 200-300ms total. */
  readonly probeTimeoutMs?: number;
}

export class AxeOSScanner {
  private readonly repo: SoloMinersRepo;
  private readonly client: AxeOSClient;
  private readonly interfaces: typeof networkInterfaces;

  constructor(options: AxeOSScannerOptions) {
    this.repo = options.repo;
    this.client =
      options.client ?? new AxeOSClient({ timeoutMs: options.probeTimeoutMs ?? 200 });
    this.interfaces = options.interfaces ?? networkInterfaces;
  }

  async scan(requestedCidr?: string | null): Promise<ScanResult> {
    let cidr: string | null;
    if (requestedCidr && requestedCidr.trim().length > 0) {
      const normalized = normalizeSlash24(requestedCidr.trim());
      if (!normalized) {
        return {
          cidr: requestedCidr,
          candidates: [],
          error: `Invalid CIDR: ${requestedCidr}. Expected a /24 like 192.168.1.0/24.`,
        };
      }
      cidr = normalized;
    } else {
      cidr = deduceLocalSlash24(this.interfaces);
    }
    if (!cidr) {
      return {
        cidr: '',
        candidates: [],
        error: 'No non-loopback IPv4 interface found - cannot infer local /24',
      };
    }

    const existing = new Set((await this.repo.list()).map((r) => r.ip));
    const ips = expandSlash24(cidr);
    const probes = ips.map(async (ip): Promise<ScanCandidate | null> => {
      const r = await this.client.getSystemInfo(ip);
      if (!r.reachable || !r.info) return null;
      // Filter on a structurally-Bitaxe-looking response: AxeOS always
      // includes either an ASICModel string OR a hashRate number. A
      // random JSON-emitting service (printer status, NAS REST) would
      // not have both shapes.
      const info = r.info;
      const looksLikeBitaxe =
        typeof info.ASICModel === 'string' ||
        typeof info.hashRate === 'number' ||
        typeof info.hashRate_1m === 'number';
      if (!looksLikeBitaxe) return null;
      return {
        ip,
        asic_model: typeof info.ASICModel === 'string' ? info.ASICModel : null,
        version: typeof info.version === 'string' ? info.version : null,
        hashrate_ghs:
          typeof info.hashRate_10m === 'number'
            ? info.hashRate_10m
            : typeof info.hashRate === 'number'
              ? info.hashRate
              : null,
        already_added: existing.has(ip),
      };
    });

    const results = await Promise.all(probes);
    const candidates: ScanCandidate[] = [];
    for (const r of results) if (r !== null) candidates.push(r);
    candidates.sort((a, b) => compareIpv4(a.ip, b.ip));
    return { cidr, candidates, error: null };
  }
}

/**
 * First non-loopback non-link-local IPv4 interface -> "<a>.<b>.<c>.0/24".
 * Returns null when no qualifying interface exists.
 */
export function deduceLocalSlash24(getIfaces: typeof networkInterfaces): string | null {
  const ifaces = getIfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) continue;
    for (const addr of list) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      // Skip link-local 169.254.0.0/16.
      if (addr.address.startsWith('169.254.')) continue;
      const parts = addr.address.split('.');
      if (parts.length !== 4) continue;
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
  }
  return null;
}

/**
 * Accept a /24 in canonical form (e.g. `192.168.1.0/24`) or a "host on
 * the subnet" form (`192.168.1.42/24`) and return the canonical `.0/24`.
 * Returns null on any other shape - we deliberately don't accept /23 or
 * /16 because the probe budget is sized for ~254 addresses.
 */
export function normalizeSlash24(input: string): string | null {
  const m = input.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/24$/);
  if (!m) return null;
  const [, a, b, c, d] = m;
  for (const octet of [a, b, c, d]) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  return `${a}.${b}.${c}.0/24`;
}

function expandSlash24(cidr: string): string[] {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.0\/24$/);
  if (!m) return [];
  const [, a, b, c] = m;
  const out: string[] = [];
  // Skip .0 (network) and .255 (broadcast).
  for (let i = 1; i < 255; i++) out.push(`${a}.${b}.${c}.${i}`);
  return out;
}

function compareIpv4(a: string, b: string): number {
  const ap = a.split('.').map(Number);
  const bp = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
